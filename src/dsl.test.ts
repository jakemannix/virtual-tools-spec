/**
 * TDD tests for the authoring DSL — convenience constructors and compile.
 *
 * The DSL is designed for two consumers:
 *   1. LLMs doing CodeAct-style tool authoring (minimal API surface)
 *   2. WYSIWYG drag-and-drop editors (autocomplete-friendly types)
 *
 * These are NOT fluent builder tests — the DSL uses plain function calls
 * with option bags, not method chains.
 */

import { describe, it, expect } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import {
  sourceTool,
  scatterGatherTool,
  pipelineTool,
  agentDef,
  compile,
  expandAggregate,
} from "./dsl.js";
import type { ToolDefinition, AgentDefinition, AggregationOp } from "./schema.js";

// ============================================================================
// Helpers
// ============================================================================

function testCard(name: string): AgentCard {
  return {
    name,
    version: "1.0.0",
    url: "https://example.com/" + name,
    protocolVersion: "0.2.1",
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    description: `Agent: ${name}`,
  };
}

// ============================================================================
// sourceTool
// ============================================================================

describe("sourceTool", () => {
  it("creates a minimal source tool", () => {
    const t = sourceTool("search", "1.0.0", {
      server: "search-service",
      tool: "raw_search",
    });
    expect(t.name).toBe("search");
    expect(t.version).toBe("1.0.0");
    expect("source" in t.implementation).toBe(true);
    if ("source" in t.implementation) {
      expect(t.implementation.source.server).toBe("search-service");
      expect(t.implementation.source.tool).toBe("raw_search");
    }
  });

  it("applies projection, defaults, and field mapping", () => {
    const t = sourceTool("search", "1.0.0", {
      server: "search-service",
      tool: "raw_search",
      projection: ["region", "format"],
      defaults: { api_key: "${ENV.SEARCH_API_KEY}" },
      fieldMapping: { search_term: "query" },
    });
    if ("source" in t.implementation) {
      expect(t.implementation.source.projection).toEqual(["region", "format"]);
      expect(t.implementation.source.defaults).toEqual({ api_key: "${ENV.SEARCH_API_KEY}" });
      expect(t.implementation.source.fieldMapping).toEqual({ search_term: "query" });
    }
  });

  it("passes through description, environment, tags, schemas", () => {
    const t = sourceTool("search", "1.0.0", {
      server: "s",
      tool: "t",
      description: "My search tool",
      environment: "prod",
      tags: ["search", "public"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(t.description).toBe("My search tool");
    expect(t.environment).toBe("prod");
    expect(t.tags).toEqual(["search", "public"]);
    expect(t.inputSchema).toEqual({ type: "object" });
    expect(t.outputSchema).toEqual({ type: "object" });
  });

  it("accepts output transform with shorthand fields", () => {
    const t = sourceTool("normalized_arxiv", "1.0.0", {
      server: "search-service",
      tool: "arxiv_search",
      outputTransform: {
        results: {
          over: "$.papers",
          fields: {
            title: "$.title",
            url: "$.pdf_url",
            source: { value: "arxiv" },
          },
        },
      },
    });
    expect(t.outputTransform).toBeDefined();
    // The shorthand "$.title" should expand to { path: "$.title" }
    const mappings = t.outputTransform!.mappings;
    expect(mappings.results).toEqual({
      over: "$.papers",
      fields: {
        title: { path: "$.title" },
        url: { path: "$.pdf_url" },
        source: { value: "arxiv" },
      },
    });
  });
});

// ============================================================================
// scatterGatherTool
// ============================================================================

describe("scatterGatherTool", () => {
  it("creates from string array of tool names", () => {
    const t = scatterGatherTool("multi_search", "1.0.0", {
      targets: ["arxiv", "github", "exa"],
    });
    expect(t.name).toBe("multi_search");
    if ("composition" in t.implementation) {
      const sg = "scatterGather" in t.implementation.composition
        ? t.implementation.composition.scatterGather
        : null;
      expect(sg).not.toBeNull();
      expect(sg!.targets).toHaveLength(3);
    }
  });

  it("accepts mixed targets: strings and objects", () => {
    const t = scatterGatherTool("multi_search", "1.0.0", {
      targets: [
        "arxiv",
        { tool: "github", optional: true },
        { tool: "exa", version: "2.*" },
      ],
    });
    if ("composition" in t.implementation) {
      const sg = t.implementation.composition;
      if ("scatterGather" in sg) {
        expect(sg.scatterGather.targets).toHaveLength(3);
        // second target should be optional
        const t2 = sg.scatterGather.targets[1];
        expect("tool" in t2 && t2.optional).toBe(true);
      }
    }
  });

  it("expands aggregate shorthand strings", () => {
    const t = scatterGatherTool("multi_search", "1.0.0", {
      targets: ["a", "b"],
      aggregate: ["extract:$.results", "flatten", "dedupe:$.url", "limit:20"],
    });
    if ("composition" in t.implementation && "scatterGather" in t.implementation.composition) {
      const ops = t.implementation.composition.scatterGather.aggregation;
      expect(ops).toHaveLength(4);
      expect(ops![0]).toEqual({ extract: { path: "$.results" } });
      expect(ops![1]).toEqual({ flatten: true });
      expect(ops![2]).toEqual({ dedupe: { field: "$.url" } });
      expect(ops![3]).toEqual({ limit: { count: 20 } });
    }
  });

  it("accepts full AggregationOp objects too", () => {
    const t = scatterGatherTool("multi", "1.0.0", {
      targets: ["a"],
      aggregate: [
        { flatten: true },
        { sort: { field: "$.score", order: "desc" } },
      ],
    });
    if ("composition" in t.implementation && "scatterGather" in t.implementation.composition) {
      const ops = t.implementation.composition.scatterGather.aggregation;
      expect(ops![1]).toEqual({ sort: { field: "$.score", order: "desc" } });
    }
  });

  it("passes through timeoutMs", () => {
    const t = scatterGatherTool("multi", "1.0.0", {
      targets: ["a"],
      timeoutMs: 5000,
    });
    if ("composition" in t.implementation && "scatterGather" in t.implementation.composition) {
      expect(t.implementation.composition.scatterGather.timeoutMs).toBe(5000);
    }
  });
});

// ============================================================================
// pipelineTool
// ============================================================================

describe("pipelineTool", () => {
  it("creates from simple step list", () => {
    const t = pipelineTool("search_and_fetch", "1.0.0", {
      steps: [
        { id: "search", tool: "multi_search" },
        { id: "fetch", tool: "batch_fetch" },
      ],
    });
    if ("composition" in t.implementation && "pipeline" in t.implementation.composition) {
      const steps = t.implementation.composition.pipeline.steps;
      expect(steps).toHaveLength(2);
      expect(steps[0].id).toBe("search");
      expect("tool" in steps[0].operation && steps[0].operation.tool).toBe("multi_search");
    }
  });

  it("supports step input bindings", () => {
    const t = pipelineTool("pipeline", "1.0.0", {
      steps: [
        { id: "search", tool: "search_tool" },
        {
          id: "fetch",
          tool: "fetch_tool",
          input: { fromStep: { stepId: "search", path: "$.results[0].url" } },
        },
      ],
    });
    if ("composition" in t.implementation && "pipeline" in t.implementation.composition) {
      const step2 = t.implementation.composition.pipeline.steps[1];
      expect(step2.input).toEqual({
        fromStep: { stepId: "search", path: "$.results[0].url" },
      });
    }
  });

  it("supports tool version on steps", () => {
    const t = pipelineTool("p", "1.0.0", {
      steps: [{ id: "s1", tool: "search", version: "2.*" }],
    });
    if ("composition" in t.implementation && "pipeline" in t.implementation.composition) {
      const op = t.implementation.composition.pipeline.steps[0].operation;
      expect("tool" in op && op.version).toBe("2.*");
    }
  });

  it("supports nested composition in a step", () => {
    const t = pipelineTool("complex", "1.0.0", {
      steps: [
        {
          id: "parallel_search",
          composition: {
            scatterGather: {
              targets: [{ tool: "arxiv" }, { tool: "exa" }],
            },
          },
        },
        { id: "process", tool: "processor" },
      ],
    });
    if ("composition" in t.implementation && "pipeline" in t.implementation.composition) {
      const step1 = t.implementation.composition.pipeline.steps[0];
      expect("composition" in step1.operation).toBe(true);
    }
  });
});

// ============================================================================
// agentDef
// ============================================================================

describe("agentDef", () => {
  it("creates an agent with card and dependencies", () => {
    const a = agentDef(testCard("research-agent"), {
      environment: "prod",
      dependencies: [
        { tool: "search", versionRange: "1.*" },
        { tool: "fetch", versionRange: ">=1.0.0" },
      ],
    });
    expect(a.agentCard.name).toBe("research-agent");
    expect(a.environment).toBe("prod");
    expect(a.dependencies).toHaveLength(2);
  });

  it("creates an agent with no dependencies", () => {
    const a = agentDef(testCard("simple-agent"), {
      environment: "stage",
    });
    expect(a.dependencies).toEqual([]);
  });

  it("accepts dependency shorthand: [toolName, range]", () => {
    const a = agentDef(testCard("agent"), {
      environment: "prod",
      dependencies: [
        ["search", "1.*"],
        ["fetch", ">=2.0.0"],
      ],
    });
    expect(a.dependencies).toEqual([
      { tool: "search", versionRange: "1.*" },
      { tool: "fetch", versionRange: ">=2.0.0" },
    ]);
  });
});

// ============================================================================
// expandAggregate (shorthand expansion)
// ============================================================================

describe("expandAggregate", () => {
  it("expands 'flatten'", () => {
    expect(expandAggregate("flatten")).toEqual({ flatten: true });
  });

  it("expands 'merge'", () => {
    expect(expandAggregate("merge")).toEqual({ merge: true });
  });

  it("expands 'extract:$.path'", () => {
    expect(expandAggregate("extract:$.results")).toEqual({
      extract: { path: "$.results" },
    });
  });

  it("expands 'dedupe:$.field'", () => {
    expect(expandAggregate("dedupe:$.url")).toEqual({
      dedupe: { field: "$.url" },
    });
  });

  it("expands 'limit:N'", () => {
    expect(expandAggregate("limit:20")).toEqual({
      limit: { count: 20 },
    });
  });

  it("expands 'sort_asc:$.field'", () => {
    expect(expandAggregate("sort_asc:$.score")).toEqual({
      sort: { field: "$.score", order: "asc" },
    });
  });

  it("expands 'sort_desc:$.field'", () => {
    expect(expandAggregate("sort_desc:$.score")).toEqual({
      sort: { field: "$.score", order: "desc" },
    });
  });

  it("expands 'wrap:fieldName'", () => {
    expect(expandAggregate("wrap:results")).toEqual({
      wrap: { field: "results" },
    });
  });

  it("passes through AggregationOp objects unchanged", () => {
    const op: AggregationOp = { flatten: true };
    expect(expandAggregate(op)).toEqual(op);
  });
});

// ============================================================================
// compile
// ============================================================================

describe("compile", () => {
  it("compiles a list of tools into a valid Registry", () => {
    const tools = [
      sourceTool("search", "1.0.0", { server: "s", tool: "t" }),
      sourceTool("fetch", "1.0.0", { server: "s", tool: "f" }),
    ];
    const result = compile({ tools });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registry.tools).toHaveLength(2);
      expect(result.registry.schemaVersion).toBe("1.0");
    }
  });

  it("compiles tools + agents", () => {
    const tools = [sourceTool("search", "1.0.0", { server: "s", tool: "t" })];
    const agents = [
      agentDef(testCard("agent"), {
        environment: "prod",
        dependencies: [["search", "1.*"]],
      }),
    ];
    const result = compile({ tools, agents });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registry.agents).toHaveLength(1);
    }
  });

  it("returns validation errors for broken composition refs", () => {
    const tools = [
      pipelineTool("bad", "1.0.0", {
        steps: [{ id: "s1", tool: "nonexistent" }],
      }),
    ];
    const result = compile({ tools });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.rule === "tool_exists")).toBe(true);
    }
  });

  it("returns validation errors for bad agent dependencies", () => {
    const tools = [sourceTool("search", "1.0.0", { server: "s", tool: "t" })];
    const agents = [
      agentDef(testCard("agent"), {
        environment: "prod",
        dependencies: [["ghost", "1.*"]],
      }),
    ];
    const result = compile({ tools, agents });
    expect(result.ok).toBe(false);
  });

  it("detects duplicate tool name+version", () => {
    const tools = [
      sourceTool("search", "1.0.0", { server: "s", tool: "t" }),
      sourceTool("search", "1.0.0", { server: "s2", tool: "t2" }),
    ];
    const result = compile({ tools });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.rule === "unique_tool")).toBe(true);
    }
  });
});
