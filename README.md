# ⚡ Strobe — Cloud-Native Multimodal AI Photo Assistant
### End-to-End Technical Reference, System Architecture & Oral Defense Guide
**Author:** tdo212 (CAB432 Cloud-Native Architecture)  
**Target Environment:** Amazon Web Services (AWS) — `ap-southeast-2` (Sydney)

---

## Table of Contents
1. [Executive Summary & High-Level Architecture](#1-executive-summary--high-level-architecture)
2. [VPC, Networking & Load Balancing Mechanics](#2-vpc-networking--load-balancing-mechanics)
3. [Containerization & Orchestration (Docker, ECR, ECS Fargate)](#3-containerization--orchestration-docker-ecr-ecs-fargate)
4. [Protocols: Agent Client Protocol (ACP) vs. Model Context Protocol (MCP)](#4-protocols-agent-client-protocol-acp-vs-model-context-protocol-mcp)
5. [Asynchronous Ingestion Pipeline (S3, EventBridge, SQS, Lambda)](#5-asynchronous-ingestion-pipeline-s3-eventbridge-sqs-lambda)
6. [Multimodal AI & Vector Retrieval (Gemma 3 Vision + Titan Multimodal)](#6-multimodal-ai--vector-retrieval-gemma-3-vision--titan-multimodal)
7. [Security, IAM Governance & Presigned URLs](#7-security-iam-governance--presigned-urls)
8. [Code Review & Annotations](#8-code-review--annotations)
9. [Oral Examination & Defense Cheat Sheet](#9-oral-examination--defense-cheat-sheet)

---

## 1. Executive Summary & High-Level Architecture

**Strobe** is a decoupled, serverless-backed AI photo assistant. The platform solves the cross-modal semantic retrieval problem: enabling users to query photographic catalogs using colloquial natural language queries (e.g., *"Show me pictures of dogs outside during sunset"*) without requiring manual photo tagging.

### System Architecture Topology

```
========================================================================================
                                     PUBLIC INTERNET
========================================================================================
           │                                                        ▲
           │ 1. HTTP GET (Port 80)                                  │ 6. Presigned GET URL
           │ 2. WS Upgrade: /acp (Port 3000)                        │    Direct from S3
           ▼                                                        │
┌─────────────────────────────────────────────────────────────────┐ │
│ Application Load Balancer (ALB) - Public Subnets (2x AZs)       │ │
│ DNS: n11332476-a2-alb-...elb.amazonaws.com                      │ │
└──────────────┬──────────────────────────────────┬───────────────┘ │
               │ Forward :80                      │ Forward :3000   │
               ▼                                  ▼                 │
┌──────────────────────────────┐   ┌──────────────────────────────┐ │
│ Target Group: webui-tg       │   │ Target Group: backend-tg     │ │
│ Target Type: 'ip'            │   │ Target Type: 'ip'            │ │
│ Health Check: GET /          │   │ Health Check: GET /healthz   │ │
└──────────────┬───────────────┘   └──────────────┬───────────────┘ │
               │ Private VPC Hop                  │ Private VPC Hop │
               ▼                                  ▼                 │
====================================================================│===================
                                AMAZON VPC (ap-southeast-2)         │
====================================================================│===================
┌──────────────────────────────┐   ┌──────────────────────────────┐ │
│ ECS Service: WebUI           │   │ ECS Service: Backend         │ │
│ Task (Fargate, 0.25 vCPU)    │   │ Task (Fargate, 0.25 vCPU)    │ │
│                              │   │                              │ │
│ ┌──────────────────────────┐ │   │ ┌──────────────────────────┐ │ │
│ │ Nginx Container (:80)    │ │   │ │ Node.js Container (:3000)│ │ │
│ │ Serves Vite/React static │ │   │ │   ai_sdk_acp_agent.mjs   │ │ │
│ │ build assets             │ │   │ └────────────┬─────────────┘ │ │
│ └──────────────────────────┘ │   │              │ stdio         │ │
│                              │   │              ▼               │ │
│                              │   │ ┌──────────────────────────┐ │ │
│                              │   │ │ MCP Child Process        │ │ │
│                              │   │ │  mcp_server_strobe.mjs   │ │ │
│                              │   │ └────────────┬─────────────┘ │ │
└──────────────────────────────┘   └──────────────┼───────────────┘ │
                                                  │                 │
             ┌────────────────────────────────────┴──────────┐      │
             ▼                                               ▼      │
   ┌───────────────────┐                           ┌────────────────┴┐
   │ Amazon Bedrock    │                           │ Amazon S3       │
   │ Model: Nemotron / │                           │ - Strobe Media  │
   │ Titan Multimodal  │                           │ - Vector Store  │
   └───────────────────┘                           └─────────────────┘
```

---

## 2. VPC, Networking & Load Balancing Mechanics

### Amazon VPC Design
* **Regional Distribution:** Deployed across two Availability Zones in `ap-southeast-2` (Sydney) for high availability.
* **Public Subnets:** Contain only the Internet-facing Application Load Balancer (ALB).
* **Private Subnets / Container Placement:** ECS Fargate tasks are isolated within subnets with controlled ingress/egress.

### Application Load Balancer (ALB) Port Multiplexing
The ALB serves two distinct application tiers over separate listener ports, eliminating the need for two independent load balancers:
1. **Port 80 (HTTP / Ingress):**
   * Default rule forwards to `n11332476-a2-webui-tg`.
   * Serves pre-compiled HTML, JavaScript bundles, and CSS via Nginx.
   * Health Check: `GET /` expects HTTP `200 OK`.
2. **Port 3000 (HTTP/1.1 Upgrade / WebSockets):**
   * Default rule forwards to `n11332476-a2-tg`.
   * Terminates client connections and negotiates an HTTP Upgrade handshake to establish persistent WebSockets (`ws://<ALB-DNS>:3000/acp`).
   * Health Check: `GET /healthz` expects HTTP `200 OK` with JSON response: `{"status":"healthy"}`.

### Dynamic IP Registration (`awsvpc`)
* Fargate allocates a dedicated Elastic Network Interface (ENI) per task.
* Target Groups are explicitly configured with `target_type = "ip"`.
* When ECS launches a task, the container agent queries the local task metadata service, obtains its private VPC IP (`172.31.x.x`), and registers that IP with the Target Group. On termination, the IP is safely deregistered.

---

## 3. Containerization & Orchestration (Docker, ECR, ECS Fargate)

### Multi-Stage Frontend Build (`acp_webui`)
The user interface is built using a two-stage Docker pipeline to maximize security and minimize deployment size:

```dockerfile
# STAGE 1: Compilation
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# STAGE 2: Lightweight Production Web Server
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

* **Footprint:** Compresses image size from $>1\text{ GB}$ (Node dev environment) down to $<50\text{ MB}$.
* **Security:** Removes Node.js, `npm`, compiler toolchains, and raw source code from the public production container.

### Backend Agent Container (`acp_servers_js`)
* Base Image: `node:22-alpine`.
* Runs `ai_sdk_acp_agent.mjs` directly.
* Spawns `mcp_server_strobe.mjs` as an isolated sub-process via standard UNIX pipes (`stdio`).

### ECR & ECS Service Definitions
* Images are tagged and stored in **Amazon Elastic Container Registry (ECR)**:
  `901444280953.dkr.ecr.ap-southeast-2.amazonaws.com`
* **Compute Allocation:** Each Fargate task is allocated `0.25 vCPU` (256 CPU units) and `512 MB` of memory, minimizing idle compute spend while maintaining responsive token streaming.
* **Desired Count & Auto-Healing:** Configured with `desiredCount: 1`. If an unhandled exception terminates the container process, the ECS control plane detects task failure, replaces the task, attaches a new ENI, and updates ALB routing targets automatically.

---

## 4. Protocols: Agent Client Protocol (ACP) vs. Model Context Protocol (MCP)

Strobe distinguishes between user-facing agent streaming and internal agent-to-tool operations using two open protocols:

```
[ Browser Client ]
        │
        │ Agent Client Protocol (ACP)
        │ Transport: Persistent WebSocket (ws://:3000/acp)
        ▼
[ Node.js Agent Runtime ] (ai_sdk_acp_agent.mjs)
        │
        │ Model Context Protocol (MCP)
        │ Transport: Local IPC child process (stdio)
        ▼
[ Strobe MCP Server ] (mcp_server_strobe.mjs)
```

| Parameter | Agent Client Protocol (ACP) | Model Context Protocol (MCP) |
| :--- | :--- | :--- |
| **Boundary** | **Browser Client $\longleftrightarrow$ Backend Agent** | **Backend Agent $\longleftrightarrow$ Tool Worker Subprocess** |
| **Transport** | **WebSockets (`ws://`)** over HTTP/1.1 Upgrade | **Standard Input / Standard Output (`stdio`)** IPC |
| **Wire Format** | JSON-RPC 2.0 streaming envelopes | JSON-RPC 2.0 tool execution specifications |
| **Purpose** | Real-time token streaming, session state management | Sandboxed tool discovery and deterministic execution |
| **Latency Profile** | Low-latency full-duplex socket | Microsecond-level local inter-process communication |

### ACP Lifecycle
1. `agent.initialize`: Exchanges protocol version capabilities.
2. `agent.session.new`: Backend establishes a memory tracking array tied to a unique `sessionId`.
3. `agent.session.prompt`: The user submits natural language queries.
4. `client.session.update`: Backend streams progressive partial tokens (`agent_message_chunk`) so the user sees live generation instead of waiting for full inference completion.

### MCP Tool Schema
The agent queries the MCP server via `listTools()` on boot, exposing three functions:
1. `search_photos`: Takes natural language text, generates a query embedding, and returns nearest-neighbor matches.
2. `get_photo_metadata`: Fetches document metadata from DynamoDB.
3. `get_photo_url`: Generates a short-lived presigned URL for secure frontend rendering.

---

## 5. Asynchronous Ingestion Pipeline (S3, EventBridge, SQS, Lambda)

When raw photos are uploaded, an event-driven serverless pipeline indexes them asynchronously:

```
[ User Upload ] ──► [ S3 Media Bucket ]
                            │
                            │ 1. S3 emits EventBridge notification
                            ▼
                    [ Amazon EventBridge ]
                    (Bus Rule: S3 Object Created)
                            │
                            │ 2. Enqueues event envelope
                            ▼
                    [ Amazon SQS Queue ]
                    (Buffer & burst absorber)
                            │
                            │ 3. Batch event poll
                            ▼
                    [ AWS Lambda Indexer ]
                            │
              ┌─────────────┴─────────────┐
              │ 4. Read Binary Buffer     │ 5. InvokeModel
              ▼                           ▼
    [ Image Binary Check ]       [ Bedrock Titan Multimodal ]
    - S3 Content-Type            (Converts image to 256-dim
    - Regex extension check       dense vector embeddings)
              │                           │
              └─────────────┬─────────────┘
                            │ 6. Persist Index
                            ▼
        ┌───────────────────────────────────────┐
        │ Storage Targets:                      │
        │ - Vector Store / S3 Vectors           │
        │ - Metadata Catalog in DynamoDB        │
        └───────────────────────────────────────┘
```

### Why SQS is Critical Between EventBridge and Lambda
If EventBridge directly invoked Lambda, a batch upload of 100 images would spin up 100 concurrent Lambda executions. This would cause:
1. Immediate throttling by Amazon Bedrock API rate limits (`429 Too Many Requests`).
2. Exhaustion of AWS account Lambda concurrency pools.
3. Unrecoverable dropped events.

**SQS resolves this:** It acts as an asynchronous buffer and "shock absorber." SQS holds incoming events securely, allowing Lambda to poll records in controlled batches (e.g., 5 to 10 at a time). If a model call temporarily fails, the message visibility timeout expires, safely retrying without data loss.

---

## 6. Multimodal AI & Vector Retrieval (Gemma 3 Vision + Titan Multimodal)

### Why Use a Two-Stage Pipeline (Caption $\rightarrow$ Embedding)?

```
[ Raw Image ] ──► [ Gemma 3 12B IT Vision ] ──► [ Dense Caption ] ──► [ Titan Multimodal ] ──► [ 256-d Vector ]
```

1. **Bridging the Cross-Modal Gap:** Raw image embeddings map surface pixel textures (colors, contrast, edges). A user searching for abstract queries (e.g., *"family picnic"*) may fail to match an image if the pixel vector only detected green grass and sunlight. Gemma Vision bridges this gap by identifying high-level semantic abstractions, human actions, and relationships.
2. **Context Enrichment:** Gemma's textual output includes subjects, actions, lighting, and OCR text, baking dense semantic signals into the subsequent embedding.
3. **Auditability & Explainability:** The caption is persisted in DynamoDB (`n11332476-photo-classifications`), allowing the ACP agent to explain *why* an image matched a query.

### Vector Dimensionality: Why 256 Dimensions?
While Amazon Titan Multimodal defaults to 1,024 dimensions, Strobe explicitly configures:
```javascript
const dimension = 256;
const payload = {
    inputText: text,
    embeddingConfig: { outputEmbeddingLength: dimension }
};
```
* **Storage Optimization:** Decreases vector footprint by 75% (from 4 KB down to 1 KB per vector).
* **Search Speed:** Calculating cosine distance across 256 floats requires 4 times fewer CPU floating-point operations than 1,024 floats, speeding up nearest-neighbor retrieval.
* **Index Compatibility:** The S3 Vectors index `11332476-index-vectors` was pre-provisioned at 256 dimensions. Dimensional consistency prevents `DimensionMismatchException`.

---

## 7. Security, IAM Governance & Presigned URLs

### Principle of Least Privilege: Dual IAM Task Roles

```
┌────────────────────────────────────────────────────────┐
│ ECS Task Definition                                    │
│                                                        │
│  ┌──────────────────────────┐ ┌──────────────────────┐ │
│  │ Execution Role           │ │ Task Role            │ │
│  │ Execution-Role-...       │ │ Task-Role-...        │ │
│  └────────────┬─────────────┘ └──────────┬───────────┘ │
└───────────────┼──────────────────────────┼─────────────┘
                │                          │
        Infrastructure Permissions   Application Code Permissions
                │                          │
        ├── ECR: GetAuthorization   ├── Bedrock: InvokeModel
        ├── ECR: BatchGetImage      ├── S3: GetObject / PutObject
        └── Logs: CreateLogStream   ├── DynamoDB: PutItem / Query
                                    └── S3Vectors: PutVectors
```

* **ECS Execution Role (`Execution-Role-CAB432-ECS`):** Used exclusively by the AWS container hypervisor agent *before* the application starts. It allows pulling Docker layers from private ECR and streaming logs to CloudWatch.
* **ECS Task Role (`Task-Role-CAB432-ECS`):** Used by the running Node.js process inside the container. The AWS SDK reads temporary credentials automatically via the local container metadata URI (`169.254.170.2`). **No access keys or secrets exist in source code.**

### Presigned URL Security Mechanics
* S3 media bucket `n11332476-strobe-media` maintains **Block Public Access = Enabled**.
* The server never proxies image bytes through the Node.js container (which would saturate container memory and create I/O bottlenecks).
* Instead, `mcp_server_strobe.mjs` executes `@aws-sdk/s3-request-presigner` using **AWS Signature Version 4 (SigV4)** in local memory:
  ```javascript
  const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
  const url = await getSignedUrl(s3Client, command, { expiresIn: 900 });
  ```
* Generates an authenticated, tamper-proof HTTPS URL containing `X-Amz-Signature` and `X-Amz-Expires=900` (15 minutes). The client browser fetches the image directly from S3 edge storage.

---

## 8. Code Review & Annotations

### Complete Ingestion Lambda Worker (`index.mjs`)

```javascript
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, PutVectorsCommand } from "@aws-sdk/client-s3vectors";

// --- Configuration Constants ---
const vectorBucketName = "n11332476-a2-vectors";
const indexName = "11332476-index-vectors";
const qutUsername = "n11332476@qut.edu.au";
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const VISION_MODEL_ID = "google.gemma-3-12b-it";
const CLASSIFICATIONS_TABLE = "n11332476-photo-classifications";
const dimension = 256;
const titanMultimodalModelId = "amazon.titan-embed-image-v1";

// --- SDK Client Initializations ---
const s3Client = new S3Client({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const client = new S3VectorsClient({ region: REGION });

/**
 * Normalizes file extensions into standard MIME types required by the Bedrock Converse API.
 */
function resolveImageFormat(key) {
    const ext = key.split('.').pop().toLowerCase();
    const formats = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp" };
    return formats[ext] || "jpeg";
}

/**
 * Calls Amazon Titan Multimodal to embed a text caption into a 256-dimensional float vector.
 */
async function embedText(text) {
    const payload = {
        inputText: text,
        embeddingConfig: { outputEmbeddingLength: dimension }
    };
    const response = await bedrockClient.send(new InvokeModelCommand({
        modelId: titanMultimodalModelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(payload)
    }));
    return JSON.parse(new TextDecoder().decode(response.body)).embedding;
}

/**
 * Main SQS Event Handler
 */
export const handler = async (event) => {
    console.log("Incoming SQS event batch:", JSON.stringify(event));

    for (const record of event.Records || []) {
        const body = JSON.parse(record.body);
        let bucketName;
        let objectKey;

        // 1. Dual Payload Extraction (Supports EventBridge envelopes and Direct S3 notifications)
        if (body.detail && body.detail.bucket && body.detail.object) {
            bucketName = body.detail.bucket.name;
            objectKey = decodeURIComponent(body.detail.object.key.replace(/\+/g, " "));
        } else if (body.Records && body.Records[0]?.s3) {
            bucketName = body.Records[0].s3.bucket.name;
            objectKey = decodeURIComponent(body.Records[0].s3.object.key.replace(/\+/g, " "));
        }

        if (!bucketName || !objectKey) {
            console.log("No valid bucket or object key found. Skipping record:", record.body);
            continue;
        }

        // 2. Safe Suffix Validation: Skip non-image files gracefully to delete them from SQS
        const lowerKey = objectKey.toLowerCase();
        if (!lowerKey.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
            console.log(`Skipping non-image key: ${objectKey}`);
            continue;
        }

        console.log(`Downloading ${objectKey} from bucket ${bucketName}`);

        try {
            // 3. Download raw image bytes from private S3 bucket
            const s3Response = await s3Client.send(new GetObjectCommand({
                Bucket: bucketName,
                Key: objectKey
            }));
            const imageBytes = await s3Response.Body.transformToByteArray();

            // 4. Pass image to Google Gemma 3 12B IT Vision via Bedrock Converse API
            const prompt = "Describe this photo concisely for an image search index. Identify the primary subject, setting, and notable visual elements.";

            const command = new ConverseCommand({
                modelId: VISION_MODEL_ID,
                messages: [
                    {
                        role: "user",
                        content: [
                            { text: prompt },
                            {
                                image: {
                                    format: resolveImageFormat(objectKey),
                                    source: { bytes: imageBytes }
                                }
                            }
                        ]
                    }
                ],
                inferenceConfig: {
                    maxTokens: 300,
                    temperature: 0.2
                }
            });

            const bedrockResponse = await bedrockClient.send(command);
            const description = (bedrockResponse.output.message.content ?? [])
                .filter(b => b.text !== undefined)
                .map(b => b.text)
                .join("");

            console.log(`Gemma description for ${objectKey}:`, description);

            // 5. Persist descriptive metadata to DynamoDB
            await docClient.send(new PutCommand({
                TableName: CLASSIFICATIONS_TABLE,
                Item: {
                    image_id: objectKey,
                    bucket: bucketName,
                    description: description,
                    classified_at: new Date().toISOString()
                }
            }));

            // 6. Convert caption to 256-d float vector via Titan Embeddings
            const captionVector = await embedText(description);
            const vectorKey = `${objectKey}#caption`;

            // 7. Upsert vector and search metadata into S3 Vectors index
            await client.send(new PutVectorsCommand({
                vectorBucketName,
                indexName,
                vectors: [
                    {
                        key: vectorKey,
                        data: { float32: captionVector },
                        metadata: {
                            kind: "image",
                            filename: objectKey,
                            description: description,
                            location: `s3://${bucketName}/${objectKey}`
                        }
                    }
                ]
            }));

            console.log(`Successfully indexed vector for ${objectKey}`);

        } catch (err) {
            console.error(`Failed processing image ${objectKey}:`, err);
            // Re-throw to inform SQS of failure for retry / DLQ routing
            throw err;
        }
    }

    return { statusCode: 200, body: "Ingestion complete" };
};
```

---

## 9. Oral Examination & Defense Cheat Sheet

### Q1: "Why did you use AWS Fargate instead of standard EC2 instances to host your containers?"
> *"Fargate provides a serverless compute engine. With standard EC2, we would be responsible for provisioning virtual machines, maintaining SSH keys, configuring the Docker daemon, and managing operating system security updates. More importantly, EC2 requires managing two layers of auto-scaling: scaling the container tasks and scaling the underlying VM instances. Fargate abstracts host management away entirely, billing strictly per-second for the 0.25 vCPU and 512 MB memory slice allocated to our tasks."*

### Q2: "How does the Application Load Balancer route traffic to your containers if Fargate does not have EC2 instance IDs?"
> *"Our tasks run in `awsvpc` network mode, which assigns each task its own dedicated Elastic Network Interface (ENI) and private IPv4 address directly inside our VPC. Our ALB Target Groups are configured with `target_type = 'ip'` rather than `'instance'`. The ECS Service coordinator automatically registers the task's dynamic private IP and port with the target group upon initialization and deregisters it during task retirement."*

### Q3: "What is the operational difference between ACP and MCP in your application?"
> *"They operate across different application boundaries:*
> * **ACP (Agent Client Protocol):** Connects the **frontend client to the backend agent** over WebSockets. It handles bidirectional user communication, session initialization, and token-by-token streaming updates (`agent_message_chunk`).
> * **MCP (Model Context Protocol):** Connects the **agent to its execution tools** locally over `stdio` child processes. It exposes discrete functions (`search_photos`, `get_photo_metadata`, `get_photo_url`) with structured JSON schemas."*

### Q4: "Why did you use Presigned URLs instead of having your Node.js container stream the image data to the client?"
> *"Proxying binary images through our Node.js container would make it an I/O bottleneck, saturating container memory buffers, consuming CPU cycles, and blocking the single-threaded Node event loop.*
> *By using AWS SigV4 presigned URLs, our media bucket maintains **Block Public Access = Enabled**. Our MCP tool signs a 15-minute temporary `GetObject` ticket in memory without making network calls to AWS. The browser then streams the binary payload directly from S3 edge storage."*

### Q5: "Why create a natural language caption with Gemma Vision before generating embeddings with Titan?"
> *"Direct image-to-vector embeddings can over-index on low-level visual textures like dominant colors or lighting contrast, missing abstract concepts. By using Google Gemma 3 12B Vision first, the model reasons about high-level semantics: identifying specific actions, subjects, settings, and relationships.*
> *Converting that rich text description into a vector via Titan Multimodal aligns user search phrasing much more closely with image concepts, bridging the cross-modal semantic gap."*

### Q6: "Why is your vector dimensionality configured to 256 instead of the default 1024?"
> *"Titan Multimodal allows configuring `outputEmbeddingLength`. Choosing 256 dimensions cuts vector storage requirements by 75% (from 4 KB to 1 KB per entry) and reduces the mathematical operations required for nearest-neighbor cosine similarity by a factor of 4.*
> *Because our pipeline first extracts descriptive captions using Gemma Vision, 256 dimensions provides sufficient expressive capacity for accurate retrieval without unnecessary compute overhead."*
