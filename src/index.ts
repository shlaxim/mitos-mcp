#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchAllServices } from "./mitos.js";
import { toolDefinitions, callTool } from "./tools.js";

const TOKEN = process.env.MITOS_MCP_AUTH_TOKEN;
const PORT = Number(process.env.PORT ?? 8743);

// Fail closed: refuse to start without an auth token (prevents accidental open deploy).
if (!TOKEN) {
  process.stderr.write("FATAL: MITOS_MCP_AUTH_TOKEN is not set. Refusing to start.\n");
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  process.stderr.write(`FATAL: PORT must be 1-65535, got: ${process.env.PORT}\n`);
  process.exit(1);
}

function tokenValid(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(TOKEN as string);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Build a fresh MCP server instance (no shared per-request state). */
function buildServer(): Server {
  const server = new Server(
    { name: "mitos-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const text = await callTool(name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });
  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  next(err as Error);
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!tokenValid(req.headers.authorization)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
}

// Stateless Streamable HTTP: a fresh transport + server per request.
app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(`/mcp error: ${err}\n`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`MITOS MCP server listening on 0.0.0.0:${PORT}\n`);
  fetchAllServices().catch((err) => process.stderr.write(`Cache warm-up failed: ${err}\n`));
});
