/**
 * Editor server — minimal HTTP API backed by RegistryService.
 *
 * Serves the editor UI at / and a REST API at /api/*.
 * Zero external dependencies beyond Node builtins + our own modules.
 *
 * Usage:
 *   npx tsx editor/server.ts [--port 3001] [--fixture fixtures/b5-lineage.json]
 *
 * API routes:
 *   GET    /api/tools                    List tools (optional ?name=&environment=)
 *   POST   /api/tools                    Create tool (validates, returns tool or violations)
 *   GET    /api/tools/:name/:version     Get tool
 *   DELETE /api/tools/:name/:version     Delete with lifecycle enforcement
 *   GET    /api/agents                   List agents (optional ?environment=)
 *   POST   /api/agents                   Create agent (validates)
 *   POST   /api/compile                  Validate a batch { tools, agents }
 *   GET    /api/lineage/forward/:type/:name  Forward lineage
 *   GET    /api/lineage/reverse/:tool        Reverse lineage (?version=&environment=)
 *   GET    /api/snapshot                 Full registry snapshot
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryService } from "../src/registry.js";
import { compile } from "../src/dsl.js";
import type { Registry } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Parse CLI args
// ============================================================================

const args = process.argv.slice(2);
let port = 3001;
let fixturePath: string | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i]);
  if (args[i] === "--fixture" && args[i + 1]) fixturePath = args[++i];
}

// ============================================================================
// Initialize registry
// ============================================================================

let svc: RegistryService;

if (fixturePath) {
  const raw = readFileSync(fixturePath, "utf-8");
  const fixture = JSON.parse(raw);
  const snapshot: Registry = fixture.registry ?? fixture;
  svc = new RegistryService(snapshot);
  console.log(
    `Loaded fixture: ${snapshot.tools.length} tools, ${(snapshot.agents ?? []).length} agents`
  );
} else {
  svc = new RegistryService();
  console.log("Starting with empty registry");
}

// ============================================================================
// HTTP server
// ============================================================================

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${port}`);
  const path = url.pathname;
  const method = req.method!;

  // CORS (for dev)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") return end(res, 204);

  try {
    // Static: serve editor and registry browser HTML
    if (path === "/" || path === "/index.html") {
      const html = readFileSync(join(__dirname, "index.html"), "utf-8");
      res.setHeader("Content-Type", "text/html");
      return end(res, 200, html);
    }
    if (path === "/registry" || path === "/registry.html") {
      const html = readFileSync(join(__dirname, "registry.html"), "utf-8");
      res.setHeader("Content-Type", "text/html");
      return end(res, 200, html);
    }

    // API routes
    if (path.startsWith("/api/")) {
      return await handleApi(method, path, url, req, res);
    }

    return json(res, 404, { error: "not_found" });
  } catch (err: any) {
    console.error(err);
    return json(res, 500, { error: "internal", message: err.message });
  }
});

async function handleApi(
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse
) {
  // --- Tools ---

  if (path === "/api/tools" && method === "GET") {
    const filter: any = {};
    if (url.searchParams.has("name")) filter.name = url.searchParams.get("name");
    if (url.searchParams.has("environment"))
      filter.environment = url.searchParams.get("environment");
    return json(res, 200, { tools: svc.listTools(filter) });
  }

  if (path === "/api/tools" && method === "POST") {
    const body = await readBody(req);
    const result = svc.createTool(body.tool ?? body);
    if (result.ok) return json(res, 201, { tool: result.value });
    return json(res, 400, {
      error: "registration_error",
      message: "Tool registration failed",
      violations: result.violations,
    });
  }

  const toolMatch = path.match(/^\/api\/tools\/([^/]+)\/([^/]+)$/);
  if (toolMatch && method === "GET") {
    const tool = svc.getTool(
      decodeURIComponent(toolMatch[1]),
      decodeURIComponent(toolMatch[2])
    );
    if (!tool) return json(res, 404, { error: "not_found" });
    return json(res, 200, { tool });
  }

  if (toolMatch && method === "DELETE") {
    const result = svc.deleteTool(
      decodeURIComponent(toolMatch[1]),
      decodeURIComponent(toolMatch[2])
    );
    return json(res, result.deleted ? 200 : 409, result);
  }

  // --- Agents ---

  if (path === "/api/agents" && method === "GET") {
    const filter: any = {};
    if (url.searchParams.has("environment"))
      filter.environment = url.searchParams.get("environment");
    return json(res, 200, { agents: svc.listAgents(filter) });
  }

  if (path === "/api/agents" && method === "POST") {
    const body = await readBody(req);
    const result = svc.createAgent(body.agent ?? body);
    if (result.ok) return json(res, 201, { agent: result.value });
    return json(res, 400, {
      error: "registration_error",
      message: "Agent registration failed",
      violations: result.violations,
    });
  }

  // --- Compile ---

  if (path === "/api/compile" && method === "POST") {
    const body = await readBody(req);
    const result = compile(body);
    if (result.ok) return json(res, 200, { registry: result.registry });
    return json(res, 400, {
      error: "validation_error",
      violations: result.violations,
    });
  }

  // --- Lineage ---

  const fwdMatch = path.match(
    /^\/api\/lineage\/forward\/(agent|tool)\/([^/]+)$/
  );
  if (fwdMatch && method === "GET") {
    const result = svc.forwardLineage(
      fwdMatch[1] as "agent" | "tool",
      decodeURIComponent(fwdMatch[2]),
      url.searchParams.get("version") ?? undefined
    );
    if (!result) return json(res, 404, { error: "not_found" });
    return json(res, 200, result);
  }

  const revMatch = path.match(/^\/api\/lineage\/reverse\/([^/]+)$/);
  if (revMatch && method === "GET") {
    const result = svc.reverseLineage(
      decodeURIComponent(revMatch[1]),
      url.searchParams.get("version") ?? undefined,
      url.searchParams.get("environment") ?? undefined
    );
    return json(res, 200, result);
  }

  // --- Snapshot ---

  if (path === "/api/snapshot" && method === "GET") {
    return json(res, 200, svc.getSnapshot());
  }

  return json(res, 404, { error: "not_found", path });
}

// ============================================================================
// Helpers
// ============================================================================

function json(res: ServerResponse, status: number, body: unknown) {
  res.setHeader("Content-Type", "application/json");
  end(res, status, JSON.stringify(body));
}

function end(res: ServerResponse, status: number, body?: string) {
  res.writeHead(status);
  res.end(body ?? "");
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ============================================================================
// Start
// ============================================================================

server.listen(port, () => {
  console.log(`Virtual Tools Editor: http://localhost:${port}`);
});
