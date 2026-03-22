/**
 * Tests for the semantic validation library.
 *
 * These test registration-time checks that go beyond schema conformance:
 * dependency resolution, environment consistency, composition integrity,
 * and DELETE lifecycle enforcement.
 */

import { describe, it, expect } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import type {
  Registry,
  ToolDefinition,
  AgentDefinition,
} from "./schema.js";
import { validateTool, validateAgent, validateDelete } from "./validate.js";

// ============================================================================
// Test helpers
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

/** A minimal registry for testing. */
function baseRegistry(): Registry {
  return {
    schemaVersion: "1.0",
    tools: [
      {
        name: "search",
        version: "1.0.0",
        environment: "prod",
        implementation: {
          source: { server: "search-service", tool: "search" },
        },
      },
      {
        name: "search",
        version: "2.0.0",
        environment: "stage",
        implementation: {
          source: { server: "search-service", tool: "search_v2" },
        },
      },
      {
        name: "fetch",
        version: "1.0.0",
        environment: "prod",
        implementation: {
          source: { server: "fetch-service", tool: "fetch_url" },
        },
      },
      {
        name: "fetch",
        version: "1.1.0",
        environment: "prod",
        implementation: {
          source: { server: "fetch-service", tool: "fetch_url" },
        },
      },
    ],
    agents: [
      {
        agentCard: testAgentCard({
          name: "research-agent",
          version: "1.0.0",
        }),
        environment: "prod",
        dependencies: [{ tool: "search", versionRange: "1.*" }],
      },
      {
        agentCard: testAgentCard({ name: "test-agent", version: "1.0.0" }),
        environment: "stage",
        dependencies: [{ tool: "search", versionRange: "2.0.0" }],
      },
    ],
    servers: [
      {
        name: "search-service",
        version: "3.0.0",
        providedTools: [
          { name: "search", version: "1.0.0" },
          { name: "search_v2", version: "2.0.0" },
        ],
      },
      {
        name: "fetch-service",
        version: "1.0.0",
        providedTools: [{ name: "fetch_url", version: "1.0.0" }],
      },
    ],
  };
}

// ============================================================================
// Tool validation — happy paths
// ============================================================================

describe("validateTool — valid tools", () => {
  it("accepts a simple source tool", () => {
    const tool: ToolDefinition = {
      name: "my-search",
      version: "1.0.0",
      implementation: {
        source: { server: "search-service", tool: "search" },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("accepts a pipeline composition referencing existing tools", () => {
    const tool: ToolDefinition = {
      name: "search-and-fetch",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              {
                id: "search",
                operation: { tool: "search", version: "1.*" },
              },
              {
                id: "fetch",
                operation: { tool: "fetch" },
                input: {
                  fromStep: { stepId: "search", path: "$.results[0].url" },
                },
              },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(true);
  });

  it("accepts a scatter-gather referencing existing tools", () => {
    const tool: ToolDefinition = {
      name: "multi-search",
      version: "1.0.0",
      implementation: {
        composition: {
          scatterGather: {
            targets: [
              { tool: "search", version: "1.*" },
              { tool: "search", version: "2.*", optional: true },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Tool validation — composition violations
// ============================================================================

describe("validateTool — composition violations", () => {
  it("rejects a pipeline referencing a nonexistent tool", () => {
    const tool: ToolDefinition = {
      name: "bad-pipeline",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              {
                id: "step1",
                operation: { tool: "nonexistent_tool" },
              },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule).toBe("tool_exists");
    expect(result.violations[0].message).toContain("nonexistent_tool");
  });

  it("rejects a pipeline with unsatisfiable version range", () => {
    const tool: ToolDefinition = {
      name: "bad-version",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              {
                id: "step1",
                operation: { tool: "search", version: "99.*" },
              },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("tool_version_satisfiable");
  });

  it("rejects duplicate step IDs", () => {
    const tool: ToolDefinition = {
      name: "dupe-steps",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              { id: "step1", operation: { tool: "search" } },
              { id: "step1", operation: { tool: "fetch" } },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("unique_step_id");
  });

  it("rejects a fromStep reference to a nonexistent step", () => {
    const tool: ToolDefinition = {
      name: "bad-ref",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              {
                id: "step1",
                operation: { tool: "search" },
                input: {
                  fromStep: { stepId: "ghost", path: "$.foo" },
                },
              },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("valid_step_reference");
  });

  it("rejects a scatter-gather target referencing nonexistent tool", () => {
    const tool: ToolDefinition = {
      name: "bad-scatter",
      version: "1.0.0",
      implementation: {
        composition: {
          scatterGather: {
            targets: [
              { tool: "search" },
              { tool: "does_not_exist" },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain("does_not_exist");
  });

  it("collects multiple violations", () => {
    const tool: ToolDefinition = {
      name: "many-problems",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              { id: "s1", operation: { tool: "ghost1" } },
              { id: "s1", operation: { tool: "ghost2" } },
            ],
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    // duplicate ID + two nonexistent tools = 3 violations
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// Tool validation — source tool violations
// ============================================================================

describe("validateTool — source tool violations", () => {
  it("rejects when backend tool doesn't exist on server", () => {
    const tool: ToolDefinition = {
      name: "bad-backend",
      version: "1.0.0",
      implementation: {
        source: { server: "search-service", tool: "nonexistent_tool" },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("backend_tool_exists");
  });

  it("rejects when server version range is unsatisfiable", () => {
    const tool: ToolDefinition = {
      name: "bad-server-ver",
      version: "1.0.0",
      implementation: {
        source: {
          server: "search-service",
          tool: "search",
          serverVersion: "99.*",
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("server_version_satisfiable");
  });

  it("rejects duplicate field mapping targets", () => {
    const tool: ToolDefinition = {
      name: "dupe-mapping",
      version: "1.0.0",
      implementation: {
        source: {
          server: "search-service",
          tool: "search",
          fieldMapping: {
            query_text: "query",
            search_query: "query",
          },
        },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("unique_field_mapping");
  });

  it("passes when server is unknown (not in registry)", () => {
    // If the server isn't registered, we can't validate backend tools.
    // This is not an error — the server may not be registered yet.
    const tool: ToolDefinition = {
      name: "unknown-server",
      version: "1.0.0",
      implementation: {
        source: { server: "mystery-service", tool: "whatever" },
      },
    };
    const result = validateTool(tool, baseRegistry());
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Agent validation — happy paths
// ============================================================================

describe("validateAgent — valid agents", () => {
  it("accepts an agent with satisfiable dependencies", () => {
    const agent: AgentDefinition = {
      agentCard: testAgentCard({ name: "good-agent", version: "1.0.0" }),
      environment: "prod",
      dependencies: [
        { tool: "search", versionRange: "1.*" },
        { tool: "fetch", versionRange: ">=1.0.0" },
      ],
    };
    const result = validateAgent(agent, baseRegistry());
    expect(result.valid).toBe(true);
  });

  it("accepts a stage agent depending on stage-only tools", () => {
    const agent: AgentDefinition = {
      agentCard: testAgentCard({ name: "stage-agent", version: "1.0.0" }),
      environment: "stage",
      dependencies: [{ tool: "search", versionRange: "2.*" }],
    };
    const result = validateAgent(agent, baseRegistry());
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Agent validation — violations
// ============================================================================

describe("validateAgent — violations", () => {
  it("rejects dependency on nonexistent tool", () => {
    const agent: AgentDefinition = {
      agentCard: testAgentCard({ name: "bad-dep", version: "1.0.0" }),
      environment: "prod",
      dependencies: [{ tool: "does_not_exist", versionRange: "1.*" }],
    };
    const result = validateAgent(agent, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("dependency_tool_exists");
  });

  it("rejects dependency with unsatisfiable version range", () => {
    const agent: AgentDefinition = {
      agentCard: testAgentCard({ name: "bad-range", version: "1.0.0" }),
      environment: "prod",
      dependencies: [{ tool: "search", versionRange: "99.*" }],
    };
    const result = validateAgent(agent, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("dependency_version_satisfiable");
  });

  it("rejects prod agent depending on stage-only tool", () => {
    const agent: AgentDefinition = {
      agentCard: testAgentCard({
        name: "prod-wants-stage",
        version: "1.0.0",
      }),
      environment: "prod",
      dependencies: [{ tool: "search", versionRange: "2.*" }],
    };
    const result = validateAgent(agent, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe(
      "dependency_environment_compatible"
    );
    expect(result.violations[0].message).toContain("stage");
  });

  it("rejects agent with missing agentCard name", () => {
    const agent: AgentDefinition = {
      agentCard: { ...testAgentCard({ name: "x", version: "1.0.0" }), name: "" } as AgentCard,
      environment: "prod",
      dependencies: [],
    };
    const result = validateAgent(agent, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe("agent_card_name");
  });

  it("collects multiple dependency violations", () => {
    const agent: AgentDefinition = {
      agentCard: testAgentCard({
        name: "multi-bad",
        version: "1.0.0",
      }),
      environment: "prod",
      dependencies: [
        { tool: "ghost", versionRange: "1.*" },
        { tool: "search", versionRange: "99.*" },
      ],
    };
    const result = validateAgent(agent, baseRegistry());
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBe(2);
  });
});

// ============================================================================
// DELETE lifecycle validation
// ============================================================================

describe("validateDelete — lifecycle enforcement", () => {
  it("blocks deletion when a prod agent depends on the only matching version", () => {
    const result = validateDelete("search", "1.0.0", baseRegistry());
    expect(result.canDelete).toBe(false);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].name).toBe("research-agent");
    expect(result.blocked[0].environment).toBe("prod");
  });

  it("allows deletion with warning when only stage agents depend", () => {
    const result = validateDelete("search", "2.0.0", baseRegistry());
    expect(result.canDelete).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe("test-agent");
    expect(result.warnings[0].environment).toBe("stage");
  });

  it("allows deletion when no agents depend on it", () => {
    const result = validateDelete("fetch", "1.0.0", baseRegistry());
    // fetch 1.1.0 still exists, so even if something depended on fetch:1.*,
    // the range is still satisfiable. But currently no agent depends on fetch.
    expect(result.canDelete).toBe(true);
    expect(result.blocked).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("allows deletion when another version satisfies the range", () => {
    // Add search 1.1.0 to the registry so search:1.* is still satisfiable
    const reg = baseRegistry();
    reg.tools.push({
      name: "search",
      version: "1.1.0",
      environment: "prod",
      implementation: {
        source: { server: "search-service", tool: "search" },
      },
    });
    const result = validateDelete("search", "1.0.0", reg);
    expect(result.canDelete).toBe(true);
    expect(result.blocked).toEqual([]);
  });

  it("detects tool-to-tool dependencies via compositions", () => {
    const reg = baseRegistry();
    reg.tools.push({
      name: "compound-search",
      version: "1.0.0",
      environment: "prod",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              { id: "s1", operation: { tool: "fetch", version: "1.0.0" } },
            ],
          },
        },
      },
    });
    // Deleting fetch 1.0.0 should be blocked by compound-search
    // (fetch 1.1.0 exists but doesn't satisfy the exact "1.0.0" range)
    const result = validateDelete("fetch", "1.0.0", reg);
    expect(result.canDelete).toBe(false);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].type).toBe("tool");
    expect(result.blocked[0].name).toBe("compound-search");
  });
});
