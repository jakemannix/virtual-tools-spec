/**
 * RegistryService — file-backed reference implementation of the
 * registry control plane API (§4.1).
 *
 * This is a slow, correct, in-memory implementation suitable for
 * testing and prototyping. For production use, back with a real
 * database. The in-memory state can be serialized to / loaded from
 * a JSON file via getSnapshot() / constructor.
 */

import semver from "semver";
import type {
  Registry,
  ToolDefinition,
  AgentDefinition,
  SchemaDefinition,
  ServerDefinition,
  CompositionSpec,
} from "./schema.js";
import type {
  RegistrationViolation,
  DeleteToolResponse,
  ForwardLineageResult,
  ResolvedDependency,
  ReverseLineageResult,
  DependentInfo,
} from "./api.js";
import { validateTool, validateAgent, validateDelete } from "./validate.js";

// ============================================================================
// Result types
// ============================================================================

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; violations: RegistrationViolation[] };

// ============================================================================
// Filter types
// ============================================================================

export interface ListToolsFilter {
  name?: string;
  version?: string;
  environment?: string;
  server?: string;
  tags?: string[];
}

export interface ListAgentsFilter {
  name?: string;
  environment?: string;
}

// ============================================================================
// RegistryService
// ============================================================================

export class RegistryService {
  private tools: ToolDefinition[] = [];
  private agents: AgentDefinition[] = [];
  private schemas: SchemaDefinition[] = [];
  private servers: ServerDefinition[] = [];

  /**
   * Create from an existing registry snapshot (e.g., loaded from file),
   * or start empty.
   */
  constructor(snapshot?: Registry) {
    if (snapshot) {
      this.tools = [...snapshot.tools];
      this.agents = [...(snapshot.agents ?? [])];
      this.schemas = [...(snapshot.schemas ?? [])];
      this.servers = [...(snapshot.servers ?? [])];
    }
  }

  // ==========================================================================
  // Snapshot
  // ==========================================================================

  /** Return the full registry as a serializable snapshot. */
  getSnapshot(): Registry {
    return {
      schemaVersion: "1.0",
      tools: [...this.tools],
      agents: [...this.agents],
      schemas: [...this.schemas],
      servers: [...this.servers],
    };
  }

  // ==========================================================================
  // Tool CRUD (§4.1.1)
  // ==========================================================================

  createTool(tool: ToolDefinition): Result<ToolDefinition> {
    // Check for duplicate
    if (this.tools.some((t) => t.name === tool.name && t.version === tool.version)) {
      return {
        ok: false,
        violations: [
          {
            field: "name+version",
            rule: "unique_tool",
            message: `Tool "${tool.name}" version ${tool.version} already exists`,
          },
        ],
      };
    }

    // Semantic validation against current registry state
    const validation = validateTool(tool, this.getSnapshot());
    if (!validation.valid) {
      return { ok: false, violations: validation.violations };
    }

    this.tools.push(tool);
    return { ok: true, value: tool };
  }

  getTool(name: string, version: string): ToolDefinition | undefined {
    return this.tools.find((t) => t.name === name && t.version === version);
  }

  listTools(filter?: ListToolsFilter): ToolDefinition[] {
    let result = this.tools;
    if (filter?.name) {
      result = result.filter((t) => t.name === filter.name);
    }
    if (filter?.environment) {
      result = result.filter((t) => t.environment === filter.environment);
    }
    if (filter?.server) {
      result = result.filter(
        (t) =>
          "source" in t.implementation &&
          t.implementation.source.server === filter.server
      );
    }
    if (filter?.tags) {
      const required = new Set(filter.tags);
      result = result.filter(
        (t) => t.tags && required.size > 0 && filter.tags!.every((tag) => t.tags!.includes(tag))
      );
    }
    return result;
  }

  deleteTool(name: string, version: string): DeleteToolResponse {
    const existing = this.getTool(name, version);
    if (!existing) {
      return { deleted: true as const };
    }

    const check = validateDelete(name, version, this.getSnapshot());

    if (!check.canDelete) {
      return {
        deleted: false as const,
        reason: `Blocked by ${check.blocked.length} prod dependent(s)`,
        dependents: check.blocked.map(toDependentInfo),
      };
    }

    // Remove the tool
    this.tools = this.tools.filter(
      (t) => !(t.name === name && t.version === version)
    );

    const warnings =
      check.warnings.length > 0
        ? check.warnings.map(toDependentInfo)
        : undefined;

    return { deleted: true as const, warnings };
  }

  // ==========================================================================
  // Agent CRUD (§4.1.2)
  // ==========================================================================

  createAgent(agent: AgentDefinition): Result<AgentDefinition> {
    const agentName = agent.agentCard.name;
    const agentVersion = agent.agentCard.version;

    // Check for duplicate
    if (
      this.agents.some(
        (a) =>
          a.agentCard.name === agentName &&
          a.agentCard.version === agentVersion
      )
    ) {
      return {
        ok: false,
        violations: [
          {
            field: "agentCard.name+version",
            rule: "unique_agent",
            message: `Agent "${agentName}" version ${agentVersion} already exists`,
          },
        ],
      };
    }

    // Semantic validation
    const validation = validateAgent(agent, this.getSnapshot());
    if (!validation.valid) {
      return { ok: false, violations: validation.violations };
    }

    this.agents.push(agent);
    return { ok: true, value: agent };
  }

  listAgents(filter?: ListAgentsFilter): AgentDefinition[] {
    let result = this.agents;
    if (filter?.name) {
      result = result.filter((a) => a.agentCard.name === filter.name);
    }
    if (filter?.environment) {
      result = result.filter((a) => a.environment === filter.environment);
    }
    return result;
  }

  // ==========================================================================
  // Schema CRUD (§4.1.3)
  // ==========================================================================

  createSchema(schema: SchemaDefinition): void {
    this.schemas.push(schema);
  }

  listSchemas(): SchemaDefinition[] {
    return [...this.schemas];
  }

  // ==========================================================================
  // Server CRUD (§4.1.4)
  // ==========================================================================

  createServer(server: ServerDefinition): void {
    this.servers.push(server);
  }

  listServers(): ServerDefinition[] {
    return [...this.servers];
  }

  // ==========================================================================
  // Lineage Queries (§4.1.5)
  // ==========================================================================

  /**
   * Forward lineage: given an entity, return all tools it depends on.
   *
   * For agents: returns declared dependencies with resolved versions.
   * For tools: returns composition sub-tool references with resolved versions.
   */
  forwardLineage(
    type: "agent" | "tool",
    name: string,
    version?: string
  ): ForwardLineageResult | undefined {
    if (type === "agent") {
      const agent = this.agents.find((a) => a.agentCard.name === name);
      if (!agent) return undefined;

      const dependencies: ResolvedDependency[] = agent.dependencies.map(
        (dep) => ({
          tool: dep.tool,
          versionRange: dep.versionRange,
          resolvedVersions: this.resolveVersions(dep.tool, dep.versionRange),
        })
      );

      return { type: "agent", name, dependencies };
    }

    // type === "tool"
    const tool = version
      ? this.getTool(name, version)
      : this.tools.find((t) => t.name === name);
    if (!tool) return undefined;

    const refs = collectToolRefs(tool);
    const dependencies: ResolvedDependency[] = refs.map((ref) => ({
      tool: ref.tool,
      versionRange: ref.version ?? "*",
      resolvedVersions: this.resolveVersions(ref.tool, ref.version ?? "*"),
    }));

    return { type: "tool", name, dependencies };
  }

  /**
   * Reverse lineage: given a tool, return all entities that depend on it.
   */
  reverseLineage(
    toolName: string,
    version?: string,
    environment?: string
  ): ReverseLineageResult {
    const dependents: DependentInfo[] = [];

    // Agent dependents
    for (const agent of this.agents) {
      if (environment && agent.environment !== environment) continue;

      for (const dep of agent.dependencies) {
        if (dep.tool !== toolName) continue;

        // If version specified, check if the range matches
        if (version && !rangeMatches(dep.versionRange, version)) continue;

        dependents.push({
          type: "agent",
          name: agent.agentCard.name,
          version: agent.agentCard.version,
          environment: agent.environment,
          versionRange: dep.versionRange,
        });
      }
    }

    // Tool dependents (compositions referencing this tool)
    for (const tool of this.tools) {
      if (environment && tool.environment !== environment) continue;

      const refs = collectToolRefs(tool);
      for (const ref of refs) {
        if (ref.tool !== toolName) continue;
        const refRange = ref.version ?? "*";
        if (version && !rangeMatches(refRange, version)) continue;

        dependents.push({
          type: "tool",
          name: tool.name,
          version: tool.version,
          environment: tool.environment,
          versionRange: refRange,
        });
      }
    }

    return { tool: toolName, version, dependents };
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  private resolveVersions(toolName: string, versionRange: string): string[] {
    return this.tools
      .filter(
        (t) => t.name === toolName && rangeMatches(versionRange, t.version)
      )
      .map((t) => t.version);
  }
}

// ============================================================================
// Shared helpers
// ============================================================================

function toDependentInfo(dep: {
  type: "agent" | "tool";
  name: string;
  version: string;
  environment?: string;
  versionRange: string;
}): DependentInfo {
  return {
    type: dep.type,
    name: dep.name,
    version: dep.version,
    environment: dep.environment,
    versionRange: dep.versionRange,
  };
}

/** Collect all tool references from a tool's composition. */
function collectToolRefs(
  tool: ToolDefinition
): { tool: string; version?: string }[] {
  const refs: { tool: string; version?: string }[] = [];
  if ("source" in tool.implementation) {
    // Source tools depend on their backend tool (if it's also registered).
    // Skip self-references (pass-through tools like exa_search wrapping exa_search).
    const backendTool = tool.implementation.source.tool;
    if (backendTool !== tool.name) {
      refs.push({ tool: backendTool });
    }
    return refs;
  }
  walkComposition(tool.implementation.composition, refs);
  return refs;
}

function walkComposition(
  spec: CompositionSpec,
  refs: { tool: string; version?: string }[]
): void {
  if ("pipeline" in spec) {
    for (const step of spec.pipeline.steps) {
      if ("tool" in step.operation) {
        refs.push({ tool: step.operation.tool, version: step.operation.version });
      } else if ("composition" in step.operation) {
        walkComposition(step.operation.composition, refs);
      }
    }
  } else {
    for (const target of spec.scatterGather.targets) {
      if ("tool" in target) {
        refs.push({ tool: target.tool, version: target.version });
      } else if ("composition" in target) {
        walkComposition(target.composition, refs);
      }
    }
  }
}

/**
 * Check if a version satisfies a range expression.
 * Handles both standard semver ranges and glob patterns (1.*, 1.2.*).
 */
function rangeMatches(range: string, version: string): boolean {
  const normalized = range
    .replace(/^(\d+)\.\*$/, ">=$1.0.0 <" + (parseInt(range) + 1) + ".0.0-0")
    .replace(
      /^(\d+)\.(\d+)\.\*$/,
      (_, maj, min) =>
        `>=${maj}.${min}.0 <${maj}.${parseInt(min) + 1}.0-0`
    );

  return semver.satisfies(version, normalized);
}
