/**
 * Tests that the Zod schema correctly validates the reference scenarios
 * from Appendix B of the requirements spec.
 *
 * These are the acceptance tests for the data model. Any implementation
 * that passes these tests conforms to the spec.
 */

import { describe, it, expect } from "vitest";
import {
  Registry,
  ToolDefinition,
  SourceTool,
  FieldExtraction,
  InputBinding,
  CompositionSpec,
  AggregationOp,
  AgentDefinition,
} from "./schema.js";

// ============================================================================
// B.1: Schema Normalization (Source Tool + Output Transform)
// ============================================================================

describe("B.1: Schema Normalization", () => {
  const normalizedArxiv: ToolDefinition = {
    name: "normalized_arxiv",
    version: "1.0.0",
    description: "arXiv search with normalized output schema",
    implementation: {
      source: {
        server: "search-service",
        tool: "arxiv_search",
      },
    },
    outputTransform: {
      mappings: {
        results: {
          over: "$.papers",
          fields: {
            title: { path: "$.title" },
            url: { path: "$.pdf_url" },
            snippet: { path: "$.abstract", default: "" },
            source: { value: "arxiv" },
          },
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
              source: { type: "string" },
            },
            required: ["title", "url", "snippet", "source"],
          },
        },
      },
      required: ["results"],
    },
  };

  it("validates the normalized_arxiv tool definition", () => {
    expect(ToolDefinition.safeParse(normalizedArxiv).success).toBe(true);
  });

  it("validates the output transform with array mapping", () => {
    const result = FieldExtraction.safeParse(
      normalizedArxiv.outputTransform!.mappings.results
    );
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// B.2: Scatter-Gather with Partial Failure
// ============================================================================

describe("B.2: Scatter-Gather with Partial Failure", () => {
  const multiSourceSearch: ToolDefinition = {
    name: "multi_source_search",
    version: "1.0.0",
    description: "Search across 4 sources in parallel",
    implementation: {
      composition: {
        scatterGather: {
          targets: [
            { tool: "normalized_exa" },
            { tool: "normalized_arxiv" },
            { tool: "normalized_github", optional: true },
            { tool: "normalized_huggingface" },
          ],
          aggregation: [
            { extract: { path: "$.results" } },
            { flatten: true },
            { dedupe: { field: "$.url" } },
            { wrap: { field: "results" } },
          ],
          timeoutMs: 30000,
        },
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "integer", default: 5 },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        results: { type: "array" },
        errors: { type: "array" },
      },
      required: ["results"],
    },
  };

  it("validates a scatter-gather with optional targets", () => {
    expect(ToolDefinition.safeParse(multiSourceSearch).success).toBe(true);
  });

  it("validates all seven aggregation op types", () => {
    const ops = [
      { extract: { path: "$.results" } },
      { flatten: true as const },
      { dedupe: { field: "$.url" } },
      { sort: { field: "$.score", order: "desc" as const } },
      { limit: { count: 10 } },
      { wrap: { field: "results" } },
      { merge: true as const },
    ];
    for (const op of ops) {
      expect(AggregationOp.safeParse(op).success).toBe(true);
    }
  });
});

// ============================================================================
// B.3: Pipeline with Cross-Service Data Flow
// ============================================================================

describe("B.3: Pipeline with Cross-Service Data Flow", () => {
  const storeResearchFinding: ToolDefinition = {
    name: "store_research_finding",
    version: "1.0.0",
    description: "Create entity, register content, and tag it",
    implementation: {
      composition: {
        pipeline: {
          steps: [
            {
              id: "create",
              operation: { tool: "create_entity" },
              input: {
                construct: {
                  fields: {
                    title: { fromInput: { path: "$.title" } },
                    description: { fromInput: { path: "$.description" } },
                    url: { fromInput: { path: "$.url" } },
                  },
                },
              },
            },
            {
              id: "register",
              operation: { tool: "register_content" },
              input: {
                construct: {
                  fields: {
                    entity_id: {
                      fromStep: { stepId: "create", path: "$.entity.id" },
                    },
                    content_type: { constant: "research_finding" },
                  },
                },
              },
            },
            {
              id: "tag",
              operation: { tool: "tag_content" },
              input: {
                construct: {
                  fields: {
                    content_id: {
                      fromStep: { stepId: "register", path: "$.content.id" },
                    },
                    tags: { fromInput: { path: "$.tags" } },
                  },
                },
              },
            },
          ],
        },
      },
    },
  };

  it("validates a 3-step pipeline with cross-step data binding", () => {
    expect(ToolDefinition.safeParse(storeResearchFinding).success).toBe(true);
  });

  it("validates construct input binding with mixed sources", () => {
    const binding: InputBinding = {
      construct: {
        fields: {
          entity_id: { fromStep: { stepId: "create", path: "$.entity.id" } },
          content_type: { constant: "research_finding" },
        },
      },
    };
    expect(InputBinding.safeParse(binding).success).toBe(true);
  });
});

// ============================================================================
// B.4: Input Projection + Defaults + Field Mapping
// ============================================================================

describe("B.4: Input Projection + Defaults + Field Mapping", () => {
  const searchTool: ToolDefinition = {
    name: "search",
    version: "1.0.0",
    description: "Simplified search with API key injected",
    implementation: {
      source: {
        server: "search-service",
        tool: "raw_search",
        projection: ["region", "format"],
        defaults: {
          api_key: "${ENV.SEARCH_API_KEY}",
        },
        fieldMapping: {
          search_term: "query",
        },
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        search_term: { type: "string" },
      },
      required: ["search_term"],
    },
  };

  it("validates a source tool with projection, defaults, and field mapping", () => {
    expect(ToolDefinition.safeParse(searchTool).success).toBe(true);
  });

  it("accepts all variable substitution patterns", () => {
    const source: SourceTool = {
      server: "backend",
      tool: "example",
      defaults: {
        api_key: "${ENV.API_KEY}",
        user_id: "${REQUEST.header.X-User-Id}",
        config_val: "${FILE.agent.properties.timeout}",
        literal: 42,
      },
    };
    expect(SourceTool.safeParse(source).success).toBe(true);
  });
});

// ============================================================================
// B.5: Lineage Query (data model validation only)
// ============================================================================

describe("B.5: Lineage Query — registry state", () => {
  const registry = {
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
    ],
    agents: [
      {
        name: "research-agent",
        version: "1.0.0",
        environment: "prod",
        dependencies: [{ tool: "search", versionRange: "1.*" }],
      },
      {
        name: "test-agent",
        version: "1.0.0",
        environment: "stage",
        dependencies: [{ tool: "search", versionRange: "2.0.0" }],
      },
    ],
  };

  it("validates a registry with versioned tools and agent dependencies", () => {
    expect(Registry.safeParse(registry).success).toBe(true);
  });

  it("validates agent dependency version ranges", () => {
    const agent: AgentDefinition = {
      name: "my-agent",
      version: "1.0.0",
      environment: "prod",
      dependencies: [
        { tool: "fetch", versionRange: "1.2.*" },
        { tool: "search", versionRange: ">=2.0.0" },
        { tool: "transform", versionRange: "^1.0.0" },
      ],
    };
    expect(AgentDefinition.safeParse(agent).success).toBe(true);
  });
});

// ============================================================================
// Negative cases — things the schema should reject
// ============================================================================

describe("Schema rejection cases", () => {
  it("rejects a tool with invalid semver", () => {
    const result = ToolDefinition.safeParse({
      name: "bad",
      version: "not-semver",
      implementation: { source: { server: "s", tool: "t" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a pipeline with zero steps", () => {
    const result = CompositionSpec.safeParse({
      pipeline: { steps: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a scatter-gather with zero targets", () => {
    const result = CompositionSpec.safeParse({
      scatterGather: { targets: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a JSONPath that doesn't start with $", () => {
    const result = FieldExtraction.safeParse({
      path: "results.title",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a limit with non-positive count", () => {
    const result = AggregationOp.safeParse({
      limit: { count: 0 },
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Nested composition — scatter-gather inside a pipeline
// ============================================================================

describe("Nested compositions", () => {
  it("validates a pipeline containing a scatter-gather step", () => {
    const tool: ToolDefinition = {
      name: "research_and_fetch",
      version: "1.0.0",
      implementation: {
        composition: {
          pipeline: {
            steps: [
              {
                id: "search",
                operation: {
                  composition: {
                    scatterGather: {
                      targets: [
                        { tool: "normalized_arxiv" },
                        { tool: "normalized_exa", optional: true },
                      ],
                      aggregation: [
                        { extract: { path: "$.results" } },
                        { flatten: true },
                      ],
                    },
                  },
                },
                input: { fromInput: { path: "$" } },
              },
              {
                id: "fetch",
                operation: { tool: "batch_fetch" },
                input: {
                  construct: {
                    fields: {
                      urls: {
                        fromStep: {
                          stepId: "search",
                          path: "$.results[*].url",
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };
    expect(ToolDefinition.safeParse(tool).success).toBe(true);
  });
});
