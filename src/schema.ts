/**
 * Virtual Tools Specification — Canonical Type Definitions
 *
 * This file is the normative source of truth for the virtual tools data model.
 * JSON Schema is generated from these definitions (see generate-schema.ts).
 *
 * Requirements reference: docs/design/virtual-tools-requirements.md v0.1
 *
 * Conventions:
 *   - Each Zod schema is exported as both a runtime validator and a TypeScript type.
 *   - JSDoc comments cite the requirement section they derive from (e.g., §4.2.1).
 *   - .strict() is used on all objects — unknown fields are rejected. Extensibility
 *     is provided via explicit `metadata` and `annotations` maps where appropriate.
 *   - Recursive types use explicit TypeScript type aliases with z.ZodType<T> annotations.
 */

import { z } from "zod";
import type { AgentCard } from "@a2a-js/sdk";

// ============================================================================
// Primitives
// ============================================================================

/** Semantic version string, e.g. "1.2.3" */
export const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Must be semver: MAJOR.MINOR.PATCH");

/**
 * SemVer range expression, e.g. "1.2.*", ">=2.0.0", "^1.0.0".
 * Exact parsing semantics are implementation-defined (node-semver compatible).
 */
export const SemVerRange = z.string().min(1);

/** JSONPath expression, e.g. "$.results[*].title" */
export const JsonPath = z
  .string()
  .regex(/^\$/, "Must be a JSONPath expression starting with $");

/** Opaque JSON Schema object — validated by JSON Schema validators, not by this spec. */
export const JsonSchemaObject = z.record(z.unknown());

// ============================================================================
// Output Transforms (§4.3)
// ============================================================================

/**
 * How to extract or produce a value for an output field.
 *
 * Three forms (§4.3.1 simplified model):
 *   - Path extraction:  { path: "$.foo", default?: "fallback" }
 *   - Constant value:   { value: "literal" }
 *   - Array mapping:    { over: "$.items", fields: { ... } }
 *
 * §4.3.1: "Each output field maps to a JSONPath expression with an optional
 * default value. If the source is an array, the mapping is applied per-element."
 */
export type FieldExtraction =
  | { path: string; default?: unknown }
  | { value: unknown }
  | { over: string; fields: Record<string, FieldExtraction> };

// Cast is the standard Zod 3 pattern for recursive types where z.unknown()
// inference doesn't exactly match the explicit type (value/constant optionality).
// Runtime behavior is verified by tests; the cast just satisfies the type checker.
export const FieldExtraction = z.union([
  z.object({
    path: JsonPath,
    default: z.unknown().optional(),
  }).strict(),
  z.object({
    value: z.unknown(),
  }).strict(),
  z.lazy(() =>
    z.object({
      over: JsonPath,
      fields: z.record(FieldExtraction),
    }).strict()
  ),
]) as z.ZodType<FieldExtraction>;

/**
 * OutputTransform — mapping from output field names to extraction expressions.
 *
 * §4.3: "An output transform is a mapping from output field names to extraction
 * expressions, where each expression pulls a value from the backend's response."
 */
export const OutputTransform = z.object({
  mappings: z.record(FieldExtraction),
});

export type OutputTransform = z.infer<typeof OutputTransform>;

// ============================================================================
// Input Customization (§4.2)
// ============================================================================

/**
 * SourceTool — a virtual tool backed by a single backend tool.
 *
 * §4.2: Three input customization operations, all validated at registration
 * time against the stored backend schema snapshot.
 */
export const SourceTool = z.object({
  /** Backend MCP server name. */
  server: z.string(),

  /**
   * SemVer range for the backend server version (§4.1.4).
   * If omitted, resolves to whatever server version is available.
   * If specified, the registry validates that a matching server version
   * exists at registration time.
   */
  serverVersion: SemVerRange.optional(),

  /** Tool name on the backend server. */
  tool: z.string(),

  /**
   * §4.2.1 Projection — fields to remove from the input schema.
   *
   * Only optional fields may be projected without a default.
   * Projecting a required field without a corresponding default
   * is a registration-time error.
   */
  projection: z.array(z.string()).optional(),

  /**
   * §4.2.2 Defaults — values injected at call time.
   *
   * String values may contain variable substitution expressions:
   *   ${ENV.VAR_NAME}          — data plane environment variable
   *   ${REQUEST.header.X-Foo}  — incoming MCP request header
   *   ${FILE.filename.key}     — side-loaded per-agent properties file
   *
   * Substitution failures are call-time errors, not registration-time errors.
   */
  defaults: z.record(z.unknown()).optional(),

  /**
   * §4.2.3 Field Mapping — rename input fields to the agent's domain language.
   *
   * Keys are agent-facing names; values are backend field names.
   * Example: { "story_id": "issue_key" }
   *
   * The agent sees and sends the keys; the data plane translates
   * to the values before forwarding to the backend.
   */
  fieldMapping: z.record(z.string()).optional(),
});

export type SourceTool = z.infer<typeof SourceTool>;

// ============================================================================
// Composition Patterns (§4.4)
// ============================================================================

// --- Input Binding (§4.4.1) ------------------------------------------------

/**
 * Where a pipeline step gets its input.
 *
 * §4.4.1 defines four options:
 *   - fromInput:  from the composition's original input (JSONPath extraction)
 *   - fromStep:   from a previous step's output (step ID + JSONPath)
 *   - constant:   a literal value
 *   - construct:  an object assembled from multiple sources
 */
export type InputBinding =
  | { fromInput: { path: string } }
  | { fromStep: { stepId: string; path: string } }
  | { constant: unknown }
  | { construct: { fields: Record<string, InputBinding> } };

export const InputBinding = z.union([
  z.object({ fromInput: z.object({ path: JsonPath }) }),
  z.object({ fromStep: z.object({ stepId: z.string(), path: JsonPath }) }),
  z.object({ constant: z.unknown() }),
  z.lazy(() =>
    z.object({ construct: z.object({ fields: z.record(InputBinding) }) })
  ),
]) as z.ZodType<InputBinding>;

// --- Aggregation (§4.4.2) --------------------------------------------------

/**
 * Operations applied in sequence to scatter-gather results.
 *
 * §4.4.2 defines seven operations:
 *   extract  — pull a field from each result (JSONPath)
 *   flatten  — flatten one level of nested arrays
 *   dedupe   — remove duplicate objects by a key field
 *   sort     — order by a field
 *   limit    — take the first N items
 *   wrap     — wrap the result array in an object
 *   merge    — merge multiple objects into one
 */
export const AggregationOp = z.union([
  z.object({ extract: z.object({ path: JsonPath }) }),
  z.object({ flatten: z.literal(true) }),
  z.object({ dedupe: z.object({ field: JsonPath }) }),
  z.object({
    sort: z.object({ field: JsonPath, order: z.enum(["asc", "desc"]) }),
  }),
  z.object({ limit: z.object({ count: z.number().int().positive() }) }),
  z.object({ wrap: z.object({ field: z.string() }) }),
  z.object({ merge: z.literal(true) }),
]);

export type AggregationOp = z.infer<typeof AggregationOp>;

// --- Forward declarations for recursive composition types ------------------

export type StepOperation =
  | { tool: string; version?: string }
  | { composition: CompositionSpec };

export type PipelineStep = {
  id: string;
  operation: StepOperation;
  input?: InputBinding;
};

export type ScatterTarget =
  | { tool: string; version?: string; optional?: boolean }
  | { composition: CompositionSpec; optional?: boolean };

export type PipelineSpec = {
  type?: "stateless";
  steps: PipelineStep[];
};

export type ScatterGatherSpec = {
  type?: "stateless";
  targets: ScatterTarget[];
  aggregation?: AggregationOp[];
  timeoutMs?: number;
};

export type CompositionSpec =
  | { pipeline: PipelineSpec }
  | { scatterGather: ScatterGatherSpec };

// --- Zod schemas for the recursive types -----------------------------------

export const StepOperation: z.ZodType<StepOperation> = z.union([
  z.object({
    tool: z.string(),
    /** SemVer range for the referenced tool. If omitted, resolves at compilation time. */
    version: SemVerRange.optional(),
  }),
  z.lazy(() => z.object({ composition: CompositionSpec })),
]);

/**
 * Pipeline step (§4.4.1).
 *
 * Each step has a unique ID (for data binding), an operation, and an
 * optional input binding. If input is omitted, the step receives the
 * composition's original input.
 */
export const PipelineStep: z.ZodType<PipelineStep> = z.object({
  id: z.string(),
  operation: StepOperation,
  input: InputBinding.optional(),
});

/**
 * Pipeline composition (§4.4.1).
 *
 * Steps execute in declared order, but independent steps (no data dependency)
 * SHOULD execute in parallel when the dependency graph allows it.
 */
export const PipelineSpec: z.ZodType<PipelineSpec> = z.object({
  /** §4.4.3 extensibility placeholder. Only "stateless" in v1. */
  type: z.literal("stateless").optional(),
  steps: z.array(PipelineStep).min(1),
});

export const ScatterTarget: z.ZodType<ScatterTarget> = z.union([
  z.object({
    tool: z.string(),
    /** SemVer range for the referenced tool. If omitted, resolves at compilation time. */
    version: SemVerRange.optional(),
    /** §4.4.2: optional targets continue on failure. */
    optional: z.boolean().optional(),
  }),
  z.lazy(() =>
    z.object({
      composition: CompositionSpec,
      optional: z.boolean().optional(),
    })
  ),
]);

/**
 * Scatter-gather composition (§4.4.2).
 *
 * Fans out the same input to N targets in parallel, then aggregates.
 * The composition fails if zero targets succeed (§4.4.2 minimum success).
 * If an optional target fails, the aggregated result includes an `errors`
 * array describing which targets failed and why.
 */
export const ScatterGatherSpec: z.ZodType<ScatterGatherSpec> = z.object({
  type: z.literal("stateless").optional(),
  targets: z.array(ScatterTarget).min(1),
  aggregation: z.array(AggregationOp).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * CompositionSpec — the top-level composition discriminator.
 *
 * §4.4: A composition is either a pipeline or a scatter-gather.
 * The discriminant is the presence of the `pipeline` or `scatterGather` key.
 */
export const CompositionSpec: z.ZodType<CompositionSpec> = z.union([
  z.object({ pipeline: PipelineSpec }),
  z.object({ scatterGather: ScatterGatherSpec }),
]);

// ============================================================================
// Composition Progress (§4.4.4)
// ============================================================================

/**
 * Progress event emitted during composition execution.
 *
 * §4.4.4: MCP tool results are atomic — `content` and `structuredContent`
 * arrive together in a single `CallToolResult`. Progress during execution
 * is communicated via MCP's `notifications/progress` mechanism, which
 * carries a numeric progress value, an optional total, and a human-readable
 * message.
 *
 * The data plane SHOULD emit one progress notification per meaningful
 * composition event (step completion, target return, target failure).
 * These types define the structure of the `message` field and the
 * optional structured `data` attached to each notification.
 */
export const CompositionProgressEvent = z.discriminatedUnion("kind", [
  /**
   * A pipeline step completed successfully.
   */
  z.object({
    kind: z.literal("step_completed"),
    stepId: z.string(),
    /** Tool that was called (if the step is a tool reference, not a nested composition). */
    tool: z.string().optional(),
  }).strict(),

  /**
   * A scatter-gather target returned successfully.
   */
  z.object({
    kind: z.literal("target_completed"),
    /** Index of the target in the scatter-gather targets array. */
    targetIndex: z.number().int().nonnegative(),
    tool: z.string().optional(),
  }).strict(),

  /**
   * A scatter-gather target failed. If the target was optional,
   * execution continues; the error is collected into the result's
   * `errors` array.
   */
  z.object({
    kind: z.literal("target_failed"),
    targetIndex: z.number().int().nonnegative(),
    tool: z.string().optional(),
    error: z.string(),
    optional: z.boolean(),
  }).strict(),

  /**
   * The composition has finished. This is the last progress event
   * before the atomic CallToolResult is returned.
   */
  z.object({
    kind: z.literal("completed"),
    /** Total execution time in milliseconds. */
    durationMs: z.number().nonnegative().optional(),
  }).strict(),
]);

export type CompositionProgressEvent = z.infer<typeof CompositionProgressEvent>;

/**
 * Shape of an MCP `notifications/progress` params object as emitted
 * by the data plane during composition execution.
 *
 * The `progressToken` is provided by the client in the original
 * `tools/call` request's `_meta.progressToken`. If the client didn't
 * provide one, the data plane MUST NOT emit progress notifications.
 *
 * The `message` field carries a human-readable summary (e.g.,
 * "arXiv search: done (3 results)"). The `data` field carries the
 * structured CompositionProgressEvent for programmatic consumers.
 */
export const CompositionProgressNotification = z.object({
  progressToken: z.union([z.string(), z.number()]),
  /** Steps or targets completed so far. */
  progress: z.number().int().nonnegative(),
  /** Total steps or targets expected. */
  total: z.number().int().positive().optional(),
  /** Human-readable progress message. */
  message: z.string().optional(),
  /** Structured event data (not part of MCP spec, but allowed in _meta). */
  data: CompositionProgressEvent.optional(),
});

export type CompositionProgressNotification = z.infer<
  typeof CompositionProgressNotification
>;

// ============================================================================
// Tool Definition (§3 "Virtual Tool", §4.1.1)
// ============================================================================

/**
 * The central entity in the registry.
 *
 * A tool is either backed by a single backend (SourceTool) or orchestrates
 * multiple tools via a composition (CompositionSpec). Both can optionally
 * customize input/output schemas and apply output transforms.
 */
export const ToolDefinition = z.object({
  name: z.string(),
  version: SemVer,
  description: z.string().optional(),

  /** §4.1.6: deployment environment — "stage", "prod", or custom. */
  environment: z.string().optional(),

  tags: z.array(z.string()).optional(),

  /**
   * §4.6.3: extensible annotation map.
   * Future use: outputDataClassification, inputDataClassification, etc.
   */
  annotations: z.record(z.unknown()).optional(),

  /** How this tool is implemented — source mapping or composition. */
  implementation: z.union([
    z.object({ source: SourceTool }),
    z.object({ composition: CompositionSpec }),
  ]),

  /**
   * Override input schema exposed to agents (§4.2).
   * If omitted, derived from the backend tool's schema
   * with projection/mapping applied.
   */
  inputSchema: JsonSchemaObject.optional(),

  /** Expected output schema (§4.3.4, §4.6.2). */
  outputSchema: JsonSchemaObject.optional(),

  /** Field mapping from backend response to agent-facing output (§4.3). */
  outputTransform: OutputTransform.optional(),

  metadata: z.record(z.unknown()).optional(),
});

export type ToolDefinition = z.infer<typeof ToolDefinition>;

// ============================================================================
// Agent Definition (§4.1.2)
// ============================================================================

/** A tool dependency with a SemVer range constraint. */
export const Dependency = z.object({
  tool: z.string(),
  versionRange: SemVerRange,
});

export type Dependency = z.infer<typeof Dependency>;

/**
 * An agent registered in the registry.
 *
 * §4.1.2: Agents are registered with an A2A AgentCard plus versioned tool
 * dependencies and an environment tag.
 *
 * The agentCard field is the full A2A AgentCard — identity, capabilities,
 * skills, transport, security. We import the type from @a2a-js/sdk rather
 * than redeclaring it, so the registry stays in sync as A2A evolves.
 * Runtime validation is a passthrough (z.custom); compile-time typing
 * comes from the AgentCard interface.
 */
export const AgentDefinition = z.object({
  /**
   * Full A2A AgentCard. The card's `name` and `version` fields are the
   * agent's canonical identity; the registry does not duplicate them.
   */
  agentCard: z.custom<AgentCard>(),

  /** §4.1.6: deployment environment. */
  environment: z.string(),

  /** §4.1.2: versioned tool dependencies. */
  dependencies: z.array(Dependency),

  metadata: z.record(z.unknown()).optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinition>;

// ============================================================================
// Schema Definition (§4.1.3)
// ============================================================================

/**
 * A named, versioned JSON Schema definition.
 *
 * §4.1.3: Tools reference schemas via $ref: "#/schemas/Name".
 * The registry resolves all $ref chains at compilation time
 * and rejects circular references.
 */
export const SchemaDefinition = z.object({
  name: z.string(),
  version: SemVer,
  description: z.string().optional(),
  schema: JsonSchemaObject,
  metadata: z.record(z.unknown()).optional(),
});

export type SchemaDefinition = z.infer<typeof SchemaDefinition>;

// ============================================================================
// Server Definition (§4.1.4)
// ============================================================================

/** A tool provided by a backend MCP server. */
export const ProvidedTool = z.object({
  name: z.string(),
  version: SemVer,
});

export type ProvidedTool = z.infer<typeof ProvidedTool>;

/**
 * A backend MCP server declaration.
 *
 * §4.1.4: Used for SBOM tracking and lifecycle validation, not routing
 * (routing is a data plane concern configured separately).
 */
export const ServerDefinition = z.object({
  name: z.string(),
  version: SemVer,
  description: z.string().optional(),
  providedTools: z.array(ProvidedTool),
  metadata: z.record(z.unknown()).optional(),
});

export type ServerDefinition = z.infer<typeof ServerDefinition>;

// ============================================================================
// Registry Snapshot (§3 "Registry")
// ============================================================================

/**
 * A complete registry snapshot — the unit of data the data plane loads
 * and caches. This is the compiled output the data plane consumes, not the
 * registry API's internal storage format.
 *
 * §3: "The data plane consumes compiled snapshots from the registry and
 * caches them. The registry is not in the hot path."
 */
export const Registry = z.object({
  schemaVersion: z.string(),
  tools: z.array(ToolDefinition),
  agents: z.array(AgentDefinition).optional(),
  schemas: z.array(SchemaDefinition).optional(),
  servers: z.array(ServerDefinition).optional(),
});

export type Registry = z.infer<typeof Registry>;
