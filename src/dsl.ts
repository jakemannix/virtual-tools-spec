/**
 * Authoring DSL — convenience constructors for virtual tool definitions.
 *
 * Designed for two consumers:
 *   1. LLMs doing CodeAct-style tool authoring (minimal API, option bags)
 *   2. WYSIWYG editors (autocomplete-friendly types with template literals)
 *
 * These are plain functions returning spec types — no builder chains.
 * The compile() function validates and assembles a Registry.
 */

import type { AgentCard } from "@a2a-js/sdk";
import type {
  ToolDefinition,
  AgentDefinition,
  Dependency,
  CompositionSpec,
  AggregationOp,
  ScatterTarget,
  PipelineStep,
  InputBinding,
  FieldExtraction,
  OutputTransform,
  Registry,
  SchemaDefinition,
  ServerDefinition,
} from "./schema.js";
import type { RegistrationViolation } from "./api.js";
import { validateTool, validateAgent } from "./validate.js";

// ============================================================================
// Autocomplete-friendly shorthand types
// ============================================================================

/**
 * Aggregate operation shorthand — string form for LLMs and dropdowns.
 *
 * Template literal types give autocomplete in VS Code / Monaco:
 * the editor shows valid prefixes when you type a string.
 */
export type AggregateShorthand =
  | "flatten"
  | "merge"
  | `extract:${string}`
  | `dedupe:${string}`
  | `sort_asc:${string}`
  | `sort_desc:${string}`
  | `limit:${number}`
  | `wrap:${string}`
  | AggregationOp;

/**
 * Scatter-gather target — string (tool name) or full options.
 */
export type TargetShorthand =
  | string
  | { tool: string; version?: string; optional?: boolean };

/**
 * Pipeline step — simplified. Either a tool name or a nested composition.
 */
export type StepShorthand = {
  id: string;
  tool?: string;
  version?: string;
  composition?: CompositionSpec;
  input?: InputBinding;
};

/**
 * Output transform field — string is a JSONPath shorthand.
 *
 *   "$.title"                → { path: "$.title" }
 *   { path: "$.x", default: "" }  → as-is
 *   { value: "literal" }    → as-is
 *   { over: "$.items", fields: { ... } } → recursive expansion
 */
export type FieldShorthand =
  | string
  | { path: string; default?: unknown }
  | { value: unknown }
  | { over: string; fields: Record<string, FieldShorthand> };

/** Dependency shorthand: [toolName, versionRange] tuple or full object. */
export type DependencyShorthand =
  | Dependency
  | [tool: string, versionRange: string];

// ============================================================================
// Source tool constructor
// ============================================================================

export interface SourceToolOptions {
  server: string;
  tool: string;
  serverVersion?: string;
  projection?: string[];
  defaults?: Record<string, unknown>;
  fieldMapping?: Record<string, string>;
  description?: string;
  environment?: string;
  tags?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputTransform?: Record<string, FieldShorthand>;
  annotations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Create a source tool — 1:1 mapping to a backend tool with optional
 * input customization (projection, defaults, field mapping).
 */
export function sourceTool(
  name: string,
  version: string,
  opts: SourceToolOptions
): ToolDefinition {
  return {
    name,
    version,
    description: opts.description,
    environment: opts.environment,
    tags: opts.tags,
    annotations: opts.annotations,
    implementation: {
      source: {
        server: opts.server,
        tool: opts.tool,
        serverVersion: opts.serverVersion,
        projection: opts.projection,
        defaults: opts.defaults,
        fieldMapping: opts.fieldMapping,
      },
    },
    inputSchema: opts.inputSchema,
    outputSchema: opts.outputSchema,
    outputTransform: opts.outputTransform
      ? expandOutputTransform(opts.outputTransform)
      : undefined,
    metadata: opts.metadata,
  };
}

// ============================================================================
// Scatter-gather tool constructor
// ============================================================================

export interface ScatterGatherToolOptions {
  targets: TargetShorthand[];
  aggregate?: AggregateShorthand[];
  timeoutMs?: number;
  description?: string;
  environment?: string;
  tags?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputTransform?: Record<string, FieldShorthand>;
  annotations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Create a scatter-gather tool — fan out to N targets in parallel,
 * then aggregate results.
 */
export function scatterGatherTool(
  name: string,
  version: string,
  opts: ScatterGatherToolOptions
): ToolDefinition {
  const targets: ScatterTarget[] = opts.targets.map(expandTarget);
  const aggregation = opts.aggregate?.map(expandAggregate);

  return {
    name,
    version,
    description: opts.description,
    environment: opts.environment,
    tags: opts.tags,
    annotations: opts.annotations,
    implementation: {
      composition: {
        scatterGather: {
          targets,
          aggregation,
          timeoutMs: opts.timeoutMs,
        },
      },
    },
    inputSchema: opts.inputSchema,
    outputSchema: opts.outputSchema,
    outputTransform: opts.outputTransform
      ? expandOutputTransform(opts.outputTransform)
      : undefined,
    metadata: opts.metadata,
  };
}

// ============================================================================
// Pipeline tool constructor
// ============================================================================

export interface PipelineToolOptions {
  steps: StepShorthand[];
  description?: string;
  environment?: string;
  tags?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputTransform?: Record<string, FieldShorthand>;
  annotations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Create a pipeline tool — sequential (or DAG) execution of steps
 * with data binding between them.
 */
export function pipelineTool(
  name: string,
  version: string,
  opts: PipelineToolOptions
): ToolDefinition {
  const steps: PipelineStep[] = opts.steps.map(expandStep);

  return {
    name,
    version,
    description: opts.description,
    environment: opts.environment,
    tags: opts.tags,
    annotations: opts.annotations,
    implementation: {
      composition: {
        pipeline: { steps },
      },
    },
    inputSchema: opts.inputSchema,
    outputSchema: opts.outputSchema,
    outputTransform: opts.outputTransform
      ? expandOutputTransform(opts.outputTransform)
      : undefined,
    metadata: opts.metadata,
  };
}

// ============================================================================
// Agent constructor
// ============================================================================

export interface AgentDefOptions {
  environment: string;
  dependencies?: DependencyShorthand[];
  metadata?: Record<string, unknown>;
}

/**
 * Create an agent definition wrapping an A2A AgentCard.
 */
export function agentDef(
  card: AgentCard,
  opts: AgentDefOptions
): AgentDefinition {
  return {
    agentCard: card,
    environment: opts.environment,
    dependencies: (opts.dependencies ?? []).map(expandDependency),
    metadata: opts.metadata,
  };
}

// ============================================================================
// Compile
// ============================================================================

export interface CompileInput {
  tools: ToolDefinition[];
  agents?: AgentDefinition[];
  schemas?: SchemaDefinition[];
  servers?: ServerDefinition[];
}

export type CompileResult =
  | { ok: true; registry: Registry }
  | { ok: false; violations: RegistrationViolation[] };

/**
 * Validate and assemble a Registry from tools, agents, schemas, servers.
 *
 * Runs semantic validation (composition references, dependency resolution,
 * environment consistency) and returns either a clean Registry or a list
 * of violations.
 */
export function compile(input: CompileInput): CompileResult {
  const violations: RegistrationViolation[] = [];

  // Build the registry snapshot incrementally so each tool validates
  // against previously added tools.
  const registry: Registry = {
    schemaVersion: "1.0",
    tools: [],
    agents: [],
    schemas: input.schemas ?? [],
    servers: input.servers ?? [],
  };

  // Check for duplicate tools
  const seen = new Set<string>();
  for (const tool of input.tools) {
    const key = `${tool.name}@${tool.version}`;
    if (seen.has(key)) {
      violations.push({
        field: "name+version",
        rule: "unique_tool",
        message: `Duplicate tool: "${tool.name}" version ${tool.version}`,
      });
    }
    seen.add(key);
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // Add all tools first (so composition refs can resolve)
  registry.tools = [...input.tools];

  // Validate each tool
  for (const tool of input.tools) {
    const result = validateTool(tool, registry);
    if (!result.valid) {
      violations.push(...result.violations);
    }
  }

  // Validate each agent
  for (const agent of input.agents ?? []) {
    const result = validateAgent(agent, registry);
    if (!result.valid) {
      violations.push(...result.violations);
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  registry.agents = input.agents ?? [];
  return { ok: true, registry };
}

// ============================================================================
// Shorthand expansion functions
// ============================================================================

/**
 * Expand an aggregate shorthand to a full AggregationOp.
 * Exported for testing and for WYSIWYG editors that want to
 * preview the expanded form.
 */
export function expandAggregate(op: AggregateShorthand): AggregationOp {
  if (typeof op !== "string") return op;

  if (op === "flatten") return { flatten: true };
  if (op === "merge") return { merge: true };

  const [prefix, arg] = splitOnce(op, ":");

  switch (prefix) {
    case "extract":
      return { extract: { path: arg } };
    case "dedupe":
      return { dedupe: { field: arg } };
    case "sort_asc":
      return { sort: { field: arg, order: "asc" } };
    case "sort_desc":
      return { sort: { field: arg, order: "desc" } };
    case "limit":
      return { limit: { count: parseInt(arg, 10) } };
    case "wrap":
      return { wrap: { field: arg } };
    default:
      throw new Error(`Unknown aggregate shorthand: "${op}"`);
  }
}

function expandTarget(t: TargetShorthand): ScatterTarget {
  if (typeof t === "string") return { tool: t };
  return t;
}

function expandStep(s: StepShorthand): PipelineStep {
  const operation = s.composition
    ? { composition: s.composition }
    : { tool: s.tool!, version: s.version };

  return {
    id: s.id,
    operation,
    input: s.input,
  };
}

function expandDependency(d: DependencyShorthand): Dependency {
  if (Array.isArray(d)) return { tool: d[0], versionRange: d[1] };
  return d;
}

function expandFieldShorthand(f: FieldShorthand): FieldExtraction {
  if (typeof f === "string") return { path: f };
  if ("over" in f) {
    const expanded: Record<string, FieldExtraction> = {};
    for (const [k, v] of Object.entries(f.fields)) {
      expanded[k] = expandFieldShorthand(v);
    }
    return { over: f.over, fields: expanded };
  }
  return f as FieldExtraction;
}

function expandOutputTransform(
  mappings: Record<string, FieldShorthand>
): OutputTransform {
  const expanded: Record<string, FieldExtraction> = {};
  for (const [k, v] of Object.entries(mappings)) {
    expanded[k] = expandFieldShorthand(v);
  }
  return { mappings: expanded };
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i === -1) return [s, ""];
  return [s.slice(0, i), s.slice(i + 1)];
}
