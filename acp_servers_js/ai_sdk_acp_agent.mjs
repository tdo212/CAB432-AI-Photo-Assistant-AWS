/** Serve the Strobe Photo Assistant to an ACP web client over WebSocket. */
import * as acp from "@agentclientprotocol/sdk";
import { createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import crypto from "node:crypto";


const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT) || 3000;
const region = process.env.AWS_REGION || "ap-southeast-2";
const modelId = process.env.BEDROCK_MODEL_ID || "nvidia.nemotron-super-3-120b";


const mcpServerPath = fileURLToPath(
    new URL("./mcp_server_strobe.mjs", import.meta.url)
);


const credentials = fromNodeProviderChain();

const bedrock = createAmazonBedrock({
    region,
    credentialProvider: fromNodeProviderChain(),
}); 


const mcpClient = new McpClient({ name: "strobe-acp-agent", version: "1.0.0" });
await mcpClient.connect(
    new StdioClientTransport({
        command: process.execPath,
        args: [mcpServerPath],
        stderr: "inherit",
        env: { ...process.env }, 
    })
);

// Verify required Strobe tools 
const { tools: discoveredTools } = await mcpClient.listTools();
const required = ["search_photos", "get_photo_metadata", "get_photo_url"];
for (const req of required) {
    if (!discoveredTools.some(({ name }) => name === req)) {
        throw new Error(`The MCP server did not provide required tool: "${req}"`);
    }
}

// Adapt the Strobe tools
const tools = {
    search_photos: tool({
        description: "Search the image catalog using semantic text similarity.",
        inputSchema: z.object({
            query: z.string().describe("The description of what image to look for"),
            topK: z.number().int().min(1).max(10).default(3).describe("Number of results to return"),
        }),
        execute: async ({ query, topK }) => {
            console.error(`[Agent -> MCP] Calling search_photos: "${query}" (topK: ${topK})`);
            const result = await mcpClient.callTool({
                name: "search_photos",
                arguments: { query, topK },
            });
            const responseText = result.content[0]?.type === "text" ? result.content[0].text : "No text returned.";
            console.error(`[MCP -> Agent] search_photos result received (${responseText.length} chars)`);
            return responseText;
        },
    }),

    get_photo_metadata: tool({
        description: "Retrieve metadata and details for a specific photo by its key or filename.",
        inputSchema: z.object({
            key: z.string().describe("The image key or filename (e.g. 'catpic.jpg')"),
        }),
        execute: async ({ key }) => {
            console.error(`[Agent -> MCP] Calling get_photo_metadata: "${key}"`);
            const result = await mcpClient.callTool({
                name: "get_photo_metadata",
                arguments: { key },
            });
            const responseText = result.content[0]?.type === "text" ? result.content[0].text : "No text returned.";
            console.error(`[MCP -> Agent] get_photo_metadata result received`);
            return responseText;
        },
    }),

    get_photo_url: tool({
        description: "Generate a secure, temporary HTTPS URL to download or view a photo.",
        inputSchema: z.object({
            key: z.string().describe("The photo object key in S3 (e.g. 'catpic.jpg')"),
            expiresInSeconds: z
                .number()
                .int()
                .min(60)
                .max(3600)
                .default(900)
                .describe("Expiry time in seconds"),
        }),
        execute: async ({ key, expiresInSeconds }) => {
            console.error(`[Agent -> MCP] Calling get_photo_url: "${key}"`);
            const result = await mcpClient.callTool({
                name: "get_photo_url",
                arguments: { key, expiresInSeconds },
            });
            const responseText = result.content[0]?.type === "text" ? result.content[0].text : "No text returned.";
            console.error(`[MCP -> Agent] get_photo_url result received`);
            return responseText;
        },
    }),
};

// ToolLoopAgent 
const agent = new ToolLoopAgent({
    model: bedrock(modelId),
    instructions:
        "You are the Strobe Photo Assistant. You help users search, inspect, and retrieve photos from their media catalog. " +
        "When a user asks to find photos, use `search_photos`. " +
        "When details about a specific image are needed, use `get_photo_metadata`. " +
        "When displaying photos to the user, call `get_photo_url` to obtain an HTTPS link and format it using markdown image syntax: ![description](url). " +
        "Always provide a complete final text response summarizing your actions and findings.",
    tools,
    stopWhen: stepCountIs(10),
});

// ACP session handlers
const sessions = new Map();
const acpAgent = acp
    .agent({ name: "strobe-bedrock-agent" })
    .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
    }))
    .onRequest(acp.methods.agent.session.new, () => {
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, []);
        return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
        const { sessionId, prompt } = context.params;
        const messages = sessions.get(sessionId);
        if (!messages) throw new Error(`Unknown session: ${sessionId}`);

        const text = prompt
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();

        if (!text) return { stopReason: "end_turn" };

        messages.push({ role: "user", content: text });

        try {
            console.error(`\n[ACP Agent] Processing user prompt: "${text}"`);
            const result = await agent.generate({ messages });
            messages.push(...result.response.messages);

            let replyText = result.text;
            if (!replyText || replyText.trim() === "") {
                const lastMsg = result.response?.messages?.slice().reverse().find((m) => m.role === "assistant");
                if (typeof lastMsg?.content === "string") {
                    replyText = lastMsg.content;
                } else if (Array.isArray(lastMsg?.content)) {
                    replyText = lastMsg.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n");
                }
            }

            if (!replyText || replyText.trim() === "") {
                replyText = "I found the matching photos and retrieved the links, but encountered an issue formatting the final response. Please try asking again.";
            }

            console.error(`[ACP Agent] Streaming response text to UI (${replyText.length} chars)`);

            await context.client.notify(acp.methods.client.session.update, {
                sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: replyText },
                },
            });

            console.error(`[ACP Agent] Turn completed successfully.`);
            return { stopReason: "end_turn" };
        } catch (agentErr) {
            console.error(`[ACP Agent] ERROR during turn:`, agentErr);
            await context.client.notify(acp.methods.client.session.update, {
                sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                        type: "text",
                        text: `⚠️ **Agent Error**: ${agentErr.message}`,
                    },
                },
            });
            return { stopReason: "end_turn" };
        }
    });

// HTTP & WebSocket server
const acpServer = new AcpServer({ agent: acpAgent });
const webSocketServer = new WebSocketServer({ noServer: true });
const upgrade = createNodeWebSocketUpgradeHandler(acpServer, webSocketServer);

const server = createServer((request, response) => {
    // 3. Health check for ALB
    if (request.url === "/healthz" || request.url === "/") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "healthy", agent: "strobe-bedrock-agent" }));
        return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Use the WebSocket endpoint at /acp.\n");
});

server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", `http://${request.headers.host}`).pathname !== "/acp") {
        socket.destroy();
        return;
    }
    upgrade(request, socket, head);
});

server.listen(port, host, () => {
    console.log(`Strobe ACP server listening at ws://${host}:${port}/acp`);
});

async function shutdown() {
    await mcpClient.close();
    server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);