/**
 * Virtual Tools Registry API — Contract Types
 *
 * Request/response shapes for the registry control plane API (§4.1).
 * These types are pure — no OpenAPI dependency. OpenAPI is generated
 * from these in generate-openapi.ts.
 *
 * Requirements reference: docs/design/virtual-tools-requirements.md §4.1
 */

import { z } from "zod";
import {
  ToolDefinition,
  AgentDefinition,
  SchemaDefinition,
  ServerDefinition,
  SemVer,
  SemVerRange,
} from "./schema.js";

// ============================================================================
// Common
// ============================================================================

/** Standard error envelope for all API errors. */
export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type ApiError = z.infer<typeof ApiError>;

// ============================================================================
// Tool API (§4.1.1)
// ============================================================================

// --- Create ---

/**
 * POST /tools
 *
 * Register a tool definition. At registration time, the registry:
 * - Fetches the backend's tools/list and stores a versioned schema snapshot
 * - Runs static validation (§4.1.1)
 * - Assigns a version if not provided
 */
export const CreateToolRequest = z.object({
  tool: ToolDefinition,
});

export type CreateToolRequest = z.infer<typeof CreateToolRequest>;

export const CreateToolResponse = z.object({
  tool: ToolDefinition,
});

export type CreateToolResponse = z.infer<typeof CreateToolResponse>;

/**
 * Registration error — static validation failed (§4.1.1).
 *
 * Reasons include:
 *   - Projected required field has no default
 *   - Default value type mismatch
 *   - Mapped field name doesn't exist in backend schema snapshot
 *   - Output transform path is syntactically invalid
 */
export const RegistrationError = z.object({
  error: z.literal("registration_error"),
  message: z.string(),
  violations: z.array(
    z.object({
      field: z.string(),
      rule: z.string(),
      message: z.string(),
    })
  ),
});

export type RegistrationError = z.infer<typeof RegistrationError>;

// --- List ---

/**
 * GET /tools
 *
 * Query parameters for listing tools.
 */
export const ListToolsParams = z.object({
  name: z.string().optional(),
  version: SemVerRange.optional(),
  environment: z.string().optional(),
  server: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type ListToolsParams = z.infer<typeof ListToolsParams>;

export const ListToolsResponse = z.object({
  tools: z.array(ToolDefinition),
});

export type ListToolsResponse = z.infer<typeof ListToolsResponse>;

// --- Get ---

/**
 * GET /tools/:name
 * GET /tools/:name/:version
 */
export const GetToolResponse = z.object({
  tool: ToolDefinition,
});

export type GetToolResponse = z.infer<typeof GetToolResponse>;

// --- Delete ---

/**
 * Info about an entity (agent or tool) that depends on a tool being deleted.
 * Used in lifecycle enforcement responses (§4.1.1).
 *
 * Dependents can be:
 *   - Agents that declare the tool in their dependencies (§4.1.2)
 *   - Other tools whose compositions reference this tool (§4.4)
 */
export const DependentInfo = z.object({
  /** "agent" or "tool" — what kind of entity depends on the target. */
  type: z.enum(["agent", "tool"]),
  name: z.string(),
  version: SemVer,
  environment: z.string().optional(),
  /** The SemVer range expression that created this dependency. */
  versionRange: SemVerRange,
  contact: z.string().optional(),
});

export type DependentInfo = z.infer<typeof DependentInfo>;

/**
 * DELETE /tools/:name/:version
 *
 * Lifecycle enforcement (§4.1.1):
 *   - prod dependents → blocked (reject with dependent details)
 *   - stage-only dependents → deleted with warnings
 *   - no dependents → deleted
 */
export const DeleteToolResponse = z.discriminatedUnion("deleted", [
  z.object({
    deleted: z.literal(true),
    warnings: z
      .array(DependentInfo)
      .optional()
      .describe("Stage-only dependents that may be affected"),
  }),
  z.object({
    deleted: z.literal(false),
    reason: z.string(),
    dependents: z
      .array(DependentInfo)
      .describe("Prod agents blocking this deletion"),
  }),
]);

export type DeleteToolResponse = z.infer<typeof DeleteToolResponse>;

// ============================================================================
// Agent API (§4.1.2)
// ============================================================================

/** POST /agents */
export const CreateAgentRequest = z.object({
  agent: AgentDefinition,
});

export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const CreateAgentResponse = z.object({
  agent: AgentDefinition,
});

export type CreateAgentResponse = z.infer<typeof CreateAgentResponse>;

/** GET /agents */
export const ListAgentsParams = z.object({
  name: z.string().optional(),
  environment: z.string().optional(),
});

export type ListAgentsParams = z.infer<typeof ListAgentsParams>;

export const ListAgentsResponse = z.object({
  agents: z.array(AgentDefinition),
});

export type ListAgentsResponse = z.infer<typeof ListAgentsResponse>;

// ============================================================================
// Schema API (§4.1.3)
// ============================================================================

/** POST /schemas */
export const CreateSchemaRequest = z.object({
  schema: SchemaDefinition,
});

export type CreateSchemaRequest = z.infer<typeof CreateSchemaRequest>;

export const CreateSchemaResponse = z.object({
  schema: SchemaDefinition,
});

export type CreateSchemaResponse = z.infer<typeof CreateSchemaResponse>;

/** GET /schemas */
export const ListSchemasResponse = z.object({
  schemas: z.array(SchemaDefinition),
});

export type ListSchemasResponse = z.infer<typeof ListSchemasResponse>;

// ============================================================================
// Server API (§4.1.4)
// ============================================================================

/** POST /servers */
export const CreateServerRequest = z.object({
  server: ServerDefinition,
});

export type CreateServerRequest = z.infer<typeof CreateServerRequest>;

export const CreateServerResponse = z.object({
  server: ServerDefinition,
});

export type CreateServerResponse = z.infer<typeof CreateServerResponse>;

/** GET /servers */
export const ListServersResponse = z.object({
  servers: z.array(ServerDefinition),
});

export type ListServersResponse = z.infer<typeof ListServersResponse>;

// ============================================================================
// Lineage API (§4.1.5)
// ============================================================================

/**
 * GET /lineage/forward/:name
 *
 * §4.1.5 Forward: Given an agent or tool, return all (tool, version)
 * tuples it depends on.
 *
 * For agents: returns declared dependencies.
 * For tools: returns composition sub-tool references + source tool backend.
 */
export const ForwardLineageParams = z.object({
  /** "agent" or "tool" */
  type: z.enum(["agent", "tool"]),
  name: z.string(),
  version: SemVer.optional(),
  environment: z.string().optional(),
});

export type ForwardLineageParams = z.infer<typeof ForwardLineageParams>;

export const ResolvedDependency = z.object({
  tool: z.string(),
  versionRange: SemVerRange,
  /** Concrete versions in the registry that satisfy this range. */
  resolvedVersions: z.array(SemVer),
});

export type ResolvedDependency = z.infer<typeof ResolvedDependency>;

export const ForwardLineageResult = z.object({
  type: z.enum(["agent", "tool"]),
  name: z.string(),
  dependencies: z.array(ResolvedDependency),
});

export type ForwardLineageResult = z.infer<typeof ForwardLineageResult>;

/**
 * GET /lineage/reverse/:toolName
 *
 * §4.1.5 Reverse: Given tool Y (optionally version Z), return all
 * agents AND tools that depend on it.
 *
 * This covers both:
 *   - Agents that declare it in their dependencies
 *   - Tools whose compositions reference it (pipeline steps, scatter targets)
 */
export const ReverseLineageParams = z.object({
  toolName: z.string(),
  version: SemVer.optional(),
  environment: z.string().optional(),
});

export type ReverseLineageParams = z.infer<typeof ReverseLineageParams>;

export const ReverseLineageResult = z.object({
  tool: z.string(),
  version: SemVer.optional(),
  dependents: z.array(DependentInfo),
});

export type ReverseLineageResult = z.infer<typeof ReverseLineageResult>;
