/** A minimal MCP server using the official TypeScript/Node SDK over stdio. */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
    GetVectorsCommand,
    QueryVectorsCommand,
    S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const dimension = 256;
const titanMultimodalModelId = "amazon.titan-embed-image-v1";
const region = process.env.AWS_REGION || "ap-southeast-2";
const vectorBucketName = process.env.VECTOR_BUCKET_NAME || "n11332476-a2-vectors";
const indexName = process.env.VECTOR_INDEX_NAME || "11332476-index-vectors";
const mediaBucketName = process.env.MEDIA_BUCKET_NAME || "n11332476-strobe-media";

// #region clients-and-index
// Omitting `credentials` allows the AWS SDK to natively resolve the ECS Task Role
const client = new S3VectorsClient({ region });
const bedrock = new BedrockRuntimeClient({ region });
const s3Client = new S3Client({ region });

// Helper for timing out hanging AWS calls
function withTimeout(promise, ms, operationName) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${operationName} timed out after ${ms / 1000}s`)), ms)
    );
    return Promise.race([promise, timeout]);
}

async function invokeTitan(payload) {
    const response = await bedrock.send(
        new InvokeModelCommand({
            modelId: titanMultimodalModelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(payload),
        })
    );
    return JSON.parse(new TextDecoder().decode(response.body)).embedding;
}

function embedText(text) {
    return invokeTitan({ inputText: text, embeddingConfig: { outputEmbeddingLength: dimension } });
}

function createServer() {
    const server = new McpServer({ name: "strobe-agent", version: "1.0.0" });

    server.registerTool(
        "search_photos",
        {
            description: "Search image catalog using semantic text similarity.",
            inputSchema: z.object({
                query: z.string().describe("The description of what image to look for"),
                topK: z.number().int().min(1).max(10).default(3).describe("Number of results to return"),
            }),
        },
        async ({ query, topK }) => {
            try {
                console.error(`[search_photos] Embedding query: "${query}"`);
                const queryVector = await embedText(query);

                console.error(`[search_photos] Querying S3 Vectors index: ${indexName}`);
                const response = await withTimeout(
                    client.send(
                        new QueryVectorsCommand({
                            vectorBucketName,
                            indexName,
                            queryVector: { float32: queryVector },
                            topK,
                            returnMetadata: true,
                            returnDistance: true,
                        })
                    ),
                    8000,
                    "S3 Vectors QueryVectorsCommand"
                );

                const vectors = response.vectors ?? [];
                if (vectors.length === 0) {
                    return {
                        content: [{ type: "text", text: `No matching images found for "${query}".` }],
                    };
                }

                const formattedResults = vectors.map((v) => ({
                    key: v.key,
                    distance: v.distance,
                    similarityPercent: `${((1 - v.distance) * 100).toFixed(2)}%`,
                    location: v.metadata?.location ?? "Unknown",
                    description: v.metadata?.description ?? "No description",
                }));

                console.error(`[search_photos] Returned ${formattedResults.length} matches`);
                return {
                    content: [{ type: "text", text: JSON.stringify(formattedResults, null, 2) }],
                };
            } catch (err) {
                console.error(`[search_photos] Error:`, err.message);
                return {
                    content: [{ type: "text", text: `Error executing vector search: ${err.message}` }],
                };
            }
        }
    );

    server.registerTool(
        "get_photo_metadata",
        {
            description: "Retrieve metadata and details for a specific photo by its key or filename.",
            inputSchema: z.object({
                key: z.string().describe("The image key or filename (e.g. 'catpic.jpg' or 'catpic.jpg#caption')"),
            }),
        },
        async ({ key }) => {
            try {
                // Build candidate keys: both raw and #caption variant
                const cleanKey = key.split("#")[0].replace(/^s3:\/\/[^\/]+\//, "");
                const candidateKeys = [cleanKey, `${cleanKey}#caption`];

                console.error(`[get_photo_metadata] Fetching metadata for keys:`, candidateKeys);

                const response = await withTimeout(
                    client.send(
                        new GetVectorsCommand({
                            vectorBucketName,
                            indexName,
                            keys: candidateKeys,
                            returnMetadata: true,
                        })
                    ),
                    8000,
                    "S3 Vectors GetVectorsCommand"
                );

                const vectors = response.vectors ?? [];
                if (vectors.length === 0) {
                    console.error(`[get_photo_metadata] No records found for "${key}"`);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({ error: `No metadata found for photo "${key}".` }),
                            },
                        ],
                    };
                }

                const item = vectors[0];
                const result = {
                    key: item.key,
                    location: item.metadata?.location ?? "Unknown",
                    description: item.metadata?.description ?? "No description available",
                };

                console.error(`[get_photo_metadata] Successfully resolved metadata for: "${item.key}"`);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            } catch (err) {
                console.error(`[get_photo_metadata] Error:`, err.message);
                return {
                    content: [{ type: "text", text: `Error retrieving photo metadata: ${err.message}` }],
                };
            }
        }
    );

    server.registerTool(
        "get_photo_url",
        {
            description: "Generate a secure, temporary HTTPS URL to download or view a photo.",
            inputSchema: z.object({
                key: z.string().describe("The photo object key in S3 (e.g. 'catpic.jpg')"),
                expiresInSeconds: z
                    .number()
                    .int()
                    .min(60)
                    .max(3600)
                    .default(900)
                    .describe("Expiry time in seconds (default 15 minutes)"),
            }),
        },
        async ({ key, expiresInSeconds }) => {
            try {
                const cleanKey = key.split("#")[0].replace(/^s3:\/\/[^\/]+\//, "").trim();
                console.error(`[get_photo_url] Presigning S3 URL for key: "${cleanKey}"`);

                const command = new GetObjectCommand({
                    Bucket: mediaBucketName,
                    Key: cleanKey,
                });

                const presignedUrl = await withTimeout(
                    getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds }),
                    5000,
                    "S3 Presign Operation"
                );

                console.error(`[get_photo_url] Successfully presigned URL for "${cleanKey}"`);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    key: cleanKey,
                                    downloadUrl: presignedUrl,
                                    expiresInSeconds,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (err) {
                console.error(`[get_photo_url] Error:`, err.message);
                return {
                    content: [{ type: "text", text: `Error generating presigned URL: ${err.message}` }],
                };
            }
        }
    );

    return server;
}

// #region stdio-transport
void serveStdio(createServer);
console.error("Strobe running");
// #endregion stdio-transport