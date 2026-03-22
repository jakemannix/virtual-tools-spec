/**
 * TDD tests for the RegistryService — file-backed reference implementation
 * of the registry control plane API.
 *
 * Tests are derived from:
 *   - fixtures/b5-lineage.json (lineage + lifecycle scenarios)
 *   - API contract types in api.ts
 *   - Validation rules in validate.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import { RegistryService } from "./registry.js";
import type {
  ToolDefinition,
  AgentDefinition,
  SchemaDefinition,
  ServerDefinition,
} from "./schema.js";

// ============================================================================
// Helpers
// ============================================================================

function testAgentCard(
  overrides: Partial<AgentCard> & { name: string; version: string }
): AgentCard {
  return {
    url: "https://example.com/agent",
    protocolVersion: "0.2.1",
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    description: `Test agent: ${overrides.name}`,
    ...overrides,
  };
}

function searchTool(version: string, env?: string): ToolDefinition {
  return {
    name: "search",
    version,
    environment: env,
    implementation: {
      source: { server: "search-service", tool: "search" },
    },
  };
}

function fetchTool(version: string, env?: string): ToolDefinition {
  return {
    name: "fetch",
    version,
    environment: env,
    implementation: {
      source: { server: "fetch-service", tool: "fetch_url" },
    },
  };
}

// ============================================================================
// Tool CRUD
// ============================================================================

describe("RegistryService — Tool CRUD", () => {
  let svc: RegistryService;

  beforeEach(() => {
    svc = new RegistryService();
  });

  it("creates and retrieves a tool", () => {
    const result = svc.createTool(searchTool("1.0.0", "prod"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("search");

    const tool = svc.getTool("search", "1.0.0");
    expect(tool).toBeDefined();
    expect(tool!.version).toBe("1.0.0");
  });

  it("lists tools with no filter", () => {
    svc.createTool(searchTool("1.0.0"));
    svc.createTool(searchTool("2.0.0"));
    svc.createTool(fetchTool("1.0.0"));

    const tools = svc.listTools();
    expect(tools).toHaveLength(3);
  });

  it("lists tools filtered by name", () => {
    svc.createTool(searchTool("1.0.0"));
    svc.createTool(searchTool("2.0.0"));
    svc.createTool(fetchTool("1.0.0"));

    const tools = svc.listTools({ name: "search" });
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.name === "search")).toBe(true);
  });

  it("lists tools filtered by environment", () => {
    svc.createTool(searchTool("1.0.0", "prod"));
    svc.createTool(searchTool("2.0.0", "stage"));

    const tools = svc.listTools({ environment: "prod" });
    expect(tools).toHaveLength(1);
    expect(tools[0].version).toBe("1.0.0");
  });

  it("rejects duplicate tool name+version", () => {
    svc.createTool(searchTool("1.0.0"));
    const result = svc.createTool(searchTool("1.0.0"));
    expect(result.ok).toBe(false);
  });

  it("getTool returns undefined for nonexistent tool", () => {
    expect(svc.getTool("ghost", "1.0.0")).toBeUndefined();
  });
});

// ============================================================================
// Tool DELETE — lifecycle enforcement (from b5-lineage fixture)
// ============================================================================

describe("RegistryService — Tool DELETE lifecycle (B.5)", () => {
  let svc: RegistryService;

  beforeEach(() => {
    // Seed with b5 fixture data
    svc = new RegistryService();
    svc.createTool(searchTool("1.0.0", "prod"));
    svc.createTool(searchTool("2.0.0", "stage"));
    svc.createAgent({
      agentCard: testAgentCard({ name: "research-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [{ tool: "search", versionRange: "1.*" }],
    });
    svc.createAgent({
      agentCard: testAgentCard({ name: "test-agent", version: "1.0.0" }),
      environment: "stage",
      dependencies: [{ tool: "search", versionRange: "2.0.0" }],
    });
  });

  it("blocks DELETE when a prod agent depends on the only matching version", () => {
    const result = svc.deleteTool("search", "1.0.0");
    expect(result.deleted).toBe(false);
    if (result.deleted) return;
    expect(result.dependents).toHaveLength(1);
    expect(result.dependents[0].name).toBe("research-agent");
    expect(result.dependents[0].environment).toBe("prod");
  });

  it("allows DELETE with warning when only stage agents depend on it", () => {
    const result = svc.deleteTool("search", "2.0.0");
    expect(result.deleted).toBe(true);
    if (!result.deleted) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0].name).toBe("test-agent");

    // Verify tool is actually removed
    expect(svc.getTool("search", "2.0.0")).toBeUndefined();
  });

  it("allows DELETE after registering a replacement version", () => {
    // Register search 1.1.0 so 1.* is still satisfiable
    svc.createTool(searchTool("1.1.0", "prod"));

    const result = svc.deleteTool("search", "1.0.0");
    expect(result.deleted).toBe(true);
    expect(svc.getTool("search", "1.0.0")).toBeUndefined();
    expect(svc.getTool("search", "1.1.0")).toBeDefined();
  });

  it("allows DELETE when no dependents exist", () => {
    svc.createTool(fetchTool("1.0.0"));
    const result = svc.deleteTool("fetch", "1.0.0");
    expect(result.deleted).toBe(true);
    if (!result.deleted) return;
    expect(result.warnings ?? []).toHaveLength(0);
  });

  it("returns deleted:true with no warnings for nonexistent tool", () => {
    const result = svc.deleteTool("ghost", "1.0.0");
    // Deleting something that doesn't exist is idempotent
    expect(result.deleted).toBe(true);
  });
});

// ============================================================================
// Agent CRUD
// ============================================================================

describe("RegistryService — Agent CRUD", () => {
  let svc: RegistryService;

  beforeEach(() => {
    svc = new RegistryService();
    svc.createTool(searchTool("1.0.0", "prod"));
    svc.createTool(fetchTool("1.0.0", "prod"));
  });

  it("creates and lists agents", () => {
    const result = svc.createAgent({
      agentCard: testAgentCard({ name: "my-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [{ tool: "search", versionRange: "1.*" }],
    });
    expect(result.ok).toBe(true);

    const agents = svc.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].agentCard.name).toBe("my-agent");
  });

  it("lists agents filtered by environment", () => {
    svc.createAgent({
      agentCard: testAgentCard({ name: "prod-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [],
    });
    svc.createAgent({
      agentCard: testAgentCard({ name: "stage-agent", version: "1.0.0" }),
      environment: "stage",
      dependencies: [],
    });

    const agents = svc.listAgents({ environment: "prod" });
    expect(agents).toHaveLength(1);
    expect(agents[0].agentCard.name).toBe("prod-agent");
  });

  it("rejects agent with nonexistent dependency", () => {
    const result = svc.createAgent({
      agentCard: testAgentCard({ name: "bad-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [{ tool: "nonexistent", versionRange: "1.*" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.rule === "dependency_tool_exists")).toBe(true);
  });

  it("rejects prod agent depending on stage-only tool", () => {
    svc.createTool(searchTool("2.0.0", "stage"));
    const result = svc.createAgent({
      agentCard: testAgentCard({ name: "bad-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [{ tool: "search", versionRange: "2.*" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.violations.some((v) => v.rule === "dependency_environment_compatible")
    ).toBe(true);
  });

  it("rejects duplicate agent name+version", () => {
    const agent: AgentDefinition = {
      agentCard: testAgentCard({ name: "agent-x", version: "1.0.0" }),
      environment: "prod",
      dependencies: [],
    };
    svc.createAgent(agent);
    const result = svc.createAgent(agent);
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// Tool validation integration
// ============================================================================

describe("RegistryService — Tool registration validation", () => {
  let svc: RegistryService;

  beforeEach(() => {
    svc = new RegistryService();
    svc.createTool(searchTool("1.0.0", "prod"));
    svc.createTool(fetchTool("1.0.0", "prod"));
  });

  it("rejects a composition referencing a nonexistent tool", () => {
    const result = svc.createTool({
      name: "bad-pipeline",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              { id: "s1", operation: { tool: "does_not_exist" } },
            ],
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.rule === "tool_exists")).toBe(true);
  });

  it("accepts a composition referencing existing tools", () => {
    const result = svc.createTool({
      name: "search-and-fetch",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              { id: "s1", operation: { tool: "search" } },
              {
                id: "s2",
                operation: { tool: "fetch" },
                input: { fromStep: { stepId: "s1", path: "$.url" } },
              },
            ],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Schema and Server CRUD
// ============================================================================

describe("RegistryService — Schema CRUD", () => {
  let svc: RegistryService;

  beforeEach(() => {
    svc = new RegistryService();
  });

  it("creates and lists schemas", () => {
    const schema: SchemaDefinition = {
      name: "SearchResult",
      version: "1.0.0",
      schema: { type: "object", properties: { title: { type: "string" } } },
    };
    svc.createSchema(schema);
    const schemas = svc.listSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("SearchResult");
  });
});

describe("RegistryService — Server CRUD", () => {
  let svc: RegistryService;

  beforeEach(() => {
    svc = new RegistryService();
  });

  it("creates and lists servers", () => {
    const server: ServerDefinition = {
      name: "search-service",
      version: "3.0.0",
      providedTools: [{ name: "search", version: "1.0.0" }],
    };
    svc.createServer(server);
    const servers = svc.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("search-service");
  });
});

// ============================================================================
// Lineage queries (from b5-lineage fixture)
// ============================================================================

describe("RegistryService — Lineage queries (B.5)", () => {
  let svc: RegistryService;

  beforeEach(() => {
    svc = new RegistryService();
    svc.createTool(searchTool("1.0.0", "prod"));
    svc.createTool(searchTool("2.0.0", "stage"));
    svc.createAgent({
      agentCard: testAgentCard({ name: "research-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [{ tool: "search", versionRange: "1.*" }],
    });
    svc.createAgent({
      agentCard: testAgentCard({ name: "test-agent", version: "1.0.0" }),
      environment: "stage",
      dependencies: [{ tool: "search", versionRange: "2.0.0" }],
    });
  });

  it("forward lineage: returns tools an agent depends on", () => {
    const result = svc.forwardLineage("agent", "research-agent");
    expect(result).toBeDefined();
    expect(result!.type).toBe("agent");
    expect(result!.name).toBe("research-agent");
    expect(result!.dependencies).toHaveLength(1);
    expect(result!.dependencies[0].tool).toBe("search");
    expect(result!.dependencies[0].versionRange).toBe("1.*");
    expect(result!.dependencies[0].resolvedVersions).toContain("1.0.0");
  });

  it("forward lineage: resolved versions update when tools are added", () => {
    svc.createTool(searchTool("1.1.0", "prod"));
    const result = svc.forwardLineage("agent", "research-agent");
    expect(result!.dependencies[0].resolvedVersions).toContain("1.0.0");
    expect(result!.dependencies[0].resolvedVersions).toContain("1.1.0");
  });

  it("forward lineage: returns tools a composition depends on", () => {
    svc.createTool({
      name: "compound",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              { id: "s1", operation: { tool: "search", version: "1.*" } },
            ],
          },
        },
      },
    });
    const result = svc.forwardLineage("tool", "compound");
    expect(result).toBeDefined();
    expect(result!.dependencies).toHaveLength(1);
    expect(result!.dependencies[0].tool).toBe("search");
  });

  it("forward lineage: returns undefined for nonexistent entity", () => {
    expect(svc.forwardLineage("agent", "ghost")).toBeUndefined();
  });

  it("reverse lineage: returns agents depending on a tool", () => {
    const result = svc.reverseLineage("search", "1.0.0");
    expect(result.dependents).toHaveLength(1);
    expect(result.dependents[0].type).toBe("agent");
    expect(result.dependents[0].name).toBe("research-agent");
  });

  it("reverse lineage: returns both agent and tool dependents", () => {
    svc.createTool({
      name: "compound",
      version: "1.0.0",
      environment: "prod",
      implementation: {
        composition: {
          scatterGather: {
            targets: [{ tool: "search", version: "1.*" }],
          },
        },
      },
    });
    const result = svc.reverseLineage("search", "1.0.0");
    expect(result.dependents.length).toBeGreaterThanOrEqual(2);
    expect(result.dependents.some((d) => d.type === "agent")).toBe(true);
    expect(result.dependents.some((d) => d.type === "tool")).toBe(true);
  });

  it("reverse lineage: empty dependents for unused tool", () => {
    svc.createTool(fetchTool("1.0.0"));
    const result = svc.reverseLineage("fetch", "1.0.0");
    expect(result.dependents).toHaveLength(0);
  });

  it("reverse lineage: filters by environment", () => {
    const result = svc.reverseLineage("search", undefined, "prod");
    // Only research-agent (prod) should appear, not test-agent (stage)
    expect(result.dependents.every((d) => d.environment === "prod")).toBe(true);
  });
});

// ============================================================================
// Snapshot — getSnapshot returns full registry
// ============================================================================

describe("RegistryService — Snapshot", () => {
  it("returns a complete registry snapshot", () => {
    const svc = new RegistryService();
    svc.createTool(searchTool("1.0.0", "prod"));
    svc.createAgent({
      agentCard: testAgentCard({ name: "my-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [],
    });

    const snapshot = svc.getSnapshot();
    expect(snapshot.schemaVersion).toBe("1.0");
    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.agents).toHaveLength(1);
  });
});
