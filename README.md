# ⚡ Strobe — Cloud-Native Multimodal AI Photo Assistant

[![AWS ECS Fargate](https://img.shields.io/badge/Compute-AWS%20ECS%20Fargate-orange?logo=amazon-aws)](https://aws.amazon.com/ecs/)
[![Bedrock](https://img.shields.io/badge/AI-Amazon%20Bedrock-blue?logo=amazon-aws)](https://aws.amazon.com/bedrock/)
[![Protocol](https://img.shields.io/badge/Protocols-ACP%20%26%20MCP-green)](#communication-protocols-acp--mcp)
[![License](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

A cloud-native, serverless AI photo cataloging and semantic search assistant deployed on **AWS ECS Fargate**, powered by **Amazon Bedrock** (Google Gemma 3 12B Vision & Amazon Titan Multimodal Embeddings), and communicating via the **Agent Client Protocol (ACP)** and **Model Context Protocol (MCP)**.

---

## 🌟 Architectural Highlights

- **Two-Stage Semantic Ingestion Pipeline:** Overcomes the cross-modal semantic gap by using **Google Gemma 3 12B Vision** to generate rich, descriptive natural-language captions before vectorizing them into **256-dimensional embeddings** via **Amazon Titan Multimodal G1**.
- **Real-Time Streaming via ACP:** Uses the **Agent Client Protocol (ACP)** over persistent WebSockets (`:3000/acp`) to stream model reasoning, partial text chunks, and tool execution states directly to the client browser.
- **Sandboxed Tool Execution via MCP:** Decouples the backend agent from discrete database tools using the **Model Context Protocol (MCP)** across local `stdio` child processes.
- **Least-Privilege Direct-to-Storage I/O:** Enforces **S3 Block Public Access** across all media buckets. Photos are displayed using time-limited (15-minute), cryptographically signed **AWS SigV4 Presigned URLs** (`GetObject`), offloading binary bandwidth from the compute tier.
- **Microservice Containerization & Port Multiplexing:** Multi-stage Docker builds deployed on serverless **AWS ECS Fargate** behind an **Application Load Balancer (ALB)** with port-based routing (Port 80 for Nginx/Vite WebUI, Port 3000 for ACP WebSocket traffic).

---

## 🏗️ System Architecture
