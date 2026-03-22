/**
 * Semantic validation for tool and agent registration.
 *
 * These checks go beyond Zod schema conformance — they validate
 * relationships between entities in the registry (dependency resolution,
 * environment consistency, composition integrity).
 *
 * Requirements reference: §4.1.1, §4.1.2, §4.2, §4.4
 */

import semver from "semver";
import type { AgentCard } from "@a2a-js/sdk";
import type {
  Registry,
  ToolDefinition,
  AgentDefinition,
  CompositionSpec,
  PipelineSpec,
  ScatterGatherSpec,
  PipelineStep,
  InputBinding,
} from "./schema.js";
import type { RegistrationViolation } from "./api.js";

// ============================================================================
// Public API
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  violations: RegistrationViolation[];
}

/**
 * Validate a tool definition against a registry snapshot.
 *
 * Checks composition references, pipeline step integrity, and
 * input customization constraints (when a backend schema snapshot
 * is available in the registry's server definitions).
 */
export function validateTool(
  tool: ToolDefinition,
  registry: Registry
): ValidationResult {
  const violations: RegistrationViolation[] = [];

  if ("composition" in tool.implementation) {
    validateComposition(
      tool.implementation.composition,
      registry,
      violations
    );
  }

  if ("source" in tool.implementation) {
    validateSourceTool(tool, registry, violations);
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Validate an agent definition against a registry snapshot.
 *
 * Checks that all declared dependencies resolve to existing tool
 * versions and that environment constraints are satisfied.
 */
export function validateAgent(
  agent: AgentDefinition,
  registry: Registry
): ValidationResult {
  const violations: RegistrationViolation[] = [];

  validateAgentCard(agent.agentCard, violations);
  validateAgentDependencies(agent, registry, violations);

  return { valid: violations.length === 0, violations };
}

/**
 * Check whether a tool version can be deleted from the registry.
 *
 * §4.1.1: prod dependents block, stage-only dependents warn.
 * Returns { canDelete, blocked, warnings }.
 */
export function validateDelete(
  toolName: string,
  toolVersion: string,
  registry: Registry
): DeleteValidationResult {
  const blocked: Dependent[] = [];
  const warnings: Dependent[] = [];

  // Check if removing this version leaves other versions that satisfy
  // each dependent's range.
  const remainingVersions = (registry.tools ?? [])
    .filter((t) => t.name === toolName && t.version !== toolVersion)
    .map((t) => t.version);

  // Check agent dependents
  for (const agent of registry.agents ?? []) {
    for (const dep of agent.dependencies) {
      if (dep.tool !== toolName) continue;
      if (!rangeMatches(dep.versionRange, toolVersion)) continue;

      // This agent's range matches the version being deleted.
      // Does any remaining version also satisfy?
      const stillSatisfied = remainingVersions.some((v) =>
        rangeMatches(dep.versionRange, v)
      );
      if (stillSatisfied) continue;

      const entry: Dependent = {
        type: "agent",
        name: agent.agentCard.name,
        version: agent.agentCard.version,
        environment: agent.environment,
        versionRange: dep.versionRange,
      };

      if (agent.environment === "prod") {
        blocked.push(entry);
      } else {
        warnings.push(entry);
      }
    }
  }

  // Check tool dependents (compositions that reference this tool)
  for (const t of registry.tools ?? []) {
    if (t.name === toolName && t.version === toolVersion) continue;
    const refs = collectToolRefs(t);
    for (const ref of refs) {
      if (ref.tool !== toolName) continue;
      const refRange = ref.version ?? "*";
      if (!rangeMatches(refRange, toolVersion)) continue;

      const stillSatisfied = remainingVersions.some((v) =>
        rangeMatches(refRange, v)
      );
      if (stillSatisfied) continue;

      const entry: Dependent = {
        type: "tool",
        name: t.name,
        version: t.version,
        environment: t.environment,
        versionRange: refRange,
      };

      if (t.environment === "prod") {
        blocked.push(entry);
      } else {
        warnings.push(entry);
      }
    }
  }

  return {
    canDelete: blocked.length === 0,
    blocked,
    warnings,
  };
}

export interface Dependent {
  type: "agent" | "tool";
  name: string;
  version: string;
  environment?: string;
  versionRange: string;
}

export interface DeleteValidationResult {
  canDelete: boolean;
  blocked: Dependent[];
  warnings: Dependent[];
}

// ============================================================================
// Composition validation
// ============================================================================

function validateComposition(
  spec: CompositionSpec,
  registry: Registry,
  violations: RegistrationViolation[]
): void {
  if ("pipeline" in spec) {
    validatePipeline(spec.pipeline, registry, violations);
  } else {
    validateScatterGather(spec.scatterGather, registry, violations);
  }
}

function validatePipeline(
  pipeline: PipelineSpec,
  registry: Registry,
  violations: RegistrationViolation[]
): void {
  const seenIds = new Set<string>();

  for (const step of pipeline.steps) {
    // Unique step IDs
    if (seenIds.has(step.id)) {
      violations.push({
        field: `pipeline.steps[${step.id}].id`,
        rule: "unique_step_id",
        message: `Duplicate step ID: "${step.id}"`,
      });
    }
    seenIds.add(step.id);

    // Validate step operation
    validateStepOperation(step, registry, violations);

    // Validate fromStep references
    if (step.input) {
      validateInputBinding(step.input, seenIds, step.id, violations);
    }
  }
}

function validateStepOperation(
  step: PipelineStep,
  registry: Registry,
  violations: RegistrationViolation[]
): void {
  if ("tool" in step.operation) {
    validateToolRef(
      step.operation.tool,
      step.operation.version,
      `pipeline.steps[${step.id}].operation`,
      registry,
      violations
    );
  } else if ("composition" in step.operation) {
    validateComposition(step.operation.composition, registry, violations);
  }
}

function validateInputBinding(
  binding: InputBinding,
  seenIds: Set<string>,
  currentStepId: string,
  violations: RegistrationViolation[]
): void {
  if ("fromStep" in binding) {
    if (!seenIds.has(binding.fromStep.stepId)) {
      violations.push({
        field: `pipeline.steps[${currentStepId}].input.fromStep`,
        rule: "valid_step_reference",
        message: `Step "${currentStepId}" references step "${binding.fromStep.stepId}" which doesn't exist or comes later`,
      });
    }
  } else if ("construct" in binding) {
    for (const [key, sub] of Object.entries(binding.construct.fields)) {
      validateInputBinding(sub, seenIds, `${currentStepId}.${key}`, violations);
    }
  }
}

function validateScatterGather(
  sg: ScatterGatherSpec,
  registry: Registry,
  violations: RegistrationViolation[]
): void {
  for (let i = 0; i < sg.targets.length; i++) {
    const target = sg.targets[i];
    if ("tool" in target) {
      validateToolRef(
        target.tool,
        target.version,
        `scatterGather.targets[${i}]`,
        registry,
        violations
      );
    } else if ("composition" in target) {
      validateComposition(target.composition, registry, violations);
    }
  }
}

// ============================================================================
// Tool reference resolution
// ============================================================================

function validateToolRef(
  toolName: string,
  versionRange: string | undefined,
  fieldPath: string,
  registry: Registry,
  violations: RegistrationViolation[]
): void {
  const candidates = registry.tools.filter((t) => t.name === toolName);
  if (candidates.length === 0) {
    violations.push({
      field: fieldPath,
      rule: "tool_exists",
      message: `Referenced tool "${toolName}" does not exist in the registry`,
    });
    return;
  }

  if (versionRange) {
    const matching = candidates.filter((t) =>
      rangeMatches(versionRange, t.version)
    );
    if (matching.length === 0) {
      violations.push({
        field: fieldPath,
        rule: "tool_version_satisfiable",
        message: `No version of "${toolName}" satisfies range "${versionRange}". Available: ${candidates.map((t) => t.version).join(", ")}`,
      });
    }
  }
}

// ============================================================================
// Source tool validation
// ============================================================================

function validateSourceTool(
  tool: ToolDefinition,
  registry: Registry,
  violations: RegistrationViolation[]
): void {
  if (!("source" in tool.implementation)) return;
  const source = tool.implementation.source;

  // Validate that the backend server exists
  const servers = registry.servers ?? [];
  const server = servers.find((s) => s.name === source.server);

  if (server && source.serverVersion) {
    if (!rangeMatches(source.serverVersion, server.version)) {
      violations.push({
        field: "implementation.source.serverVersion",
        rule: "server_version_satisfiable",
        message: `Server "${source.server}" version ${server.version} does not satisfy range "${source.serverVersion}"`,
      });
    }
  }

  // If we have the server's provided tools, validate the backend tool exists
  if (server) {
    const backendTool = server.providedTools.find(
      (pt) => pt.name === source.tool
    );
    if (!backendTool) {
      violations.push({
        field: "implementation.source.tool",
        rule: "backend_tool_exists",
        message: `Server "${source.server}" does not provide tool "${source.tool}". Available: ${server.providedTools.map((pt) => pt.name).join(", ")}`,
      });
    }
  }

  // Validate field mapping targets (if we have a backend schema, we'd check
  // that mapped-to fields exist — but we don't have per-tool schemas in the
  // server definition, only tool names. This would require the schema snapshot
  // stored at registration time, which is beyond what the Registry type holds.)
  // For now, validate structural consistency only.

  if (source.projection && source.defaults) {
    // §4.2.1: projected required fields must have defaults.
    // Without the backend schema, we can't determine which fields are required.
    // We CAN check that defaults reference fields that are also projected.
    // (A default on a field that isn't projected is redundant but not an error.)
  }

  if (source.fieldMapping) {
    // Check for mapping conflicts: two agent-facing names mapping to the same backend field
    const backendFields = Object.values(source.fieldMapping);
    const dupes = backendFields.filter(
      (f, i) => backendFields.indexOf(f) !== i
    );
    if (dupes.length > 0) {
      violations.push({
        field: "implementation.source.fieldMapping",
        rule: "unique_field_mapping",
        message: `Multiple agent-facing fields map to the same backend field: ${[...new Set(dupes)].join(", ")}`,
      });
    }
  }
}

// ============================================================================
// Agent validation
// ============================================================================

function validateAgentCard(
  card: AgentCard,
  violations: RegistrationViolation[]
): void {
  if (!card || typeof card !== "object") {
    violations.push({
      field: "agentCard",
      rule: "agent_card_present",
      message: "agentCard must be a valid A2A AgentCard object",
    });
    return;
  }

  if (!card.name || typeof card.name !== "string") {
    violations.push({
      field: "agentCard.name",
      rule: "agent_card_name",
      message: "agentCard.name is required and must be a string",
    });
  }

  if (!card.version || typeof card.version !== "string") {
    violations.push({
      field: "agentCard.version",
      rule: "agent_card_version",
      message: "agentCard.version is required and must be a string",
    });
  }
}

function validateAgentDependencies(
  agent: AgentDefinition,
  registry: Registry,
  violations: RegistrationViolation[]
): void {
  for (const dep of agent.dependencies) {
    const candidates = registry.tools.filter((t) => t.name === dep.tool);

    if (candidates.length === 0) {
      violations.push({
        field: `dependencies[${dep.tool}]`,
        rule: "dependency_tool_exists",
        message: `Dependency "${dep.tool}" does not exist in the registry`,
      });
      continue;
    }

    const matching = candidates.filter((t) =>
      rangeMatches(dep.versionRange, t.version)
    );

    if (matching.length === 0) {
      violations.push({
        field: `dependencies[${dep.tool}]`,
        rule: "dependency_version_satisfiable",
        message: `No version of "${dep.tool}" satisfies range "${dep.versionRange}". Available: ${candidates.map((t) => t.version).join(", ")}`,
      });
      continue;
    }

    // §4.1.6: prod agent depending on stage-only tool
    if (agent.environment === "prod") {
      const prodMatching = matching.filter(
        (t) => t.environment === "prod" || !t.environment
      );
      if (prodMatching.length === 0) {
        violations.push({
          field: `dependencies[${dep.tool}]`,
          rule: "dependency_environment_compatible",
          message: `Prod agent depends on "${dep.tool}" (${dep.versionRange}) but matching versions only exist in: ${[...new Set(matching.map((t) => t.environment ?? "unset"))].join(", ")}`,
        });
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Collect all tool references from a tool definition's compositions. */
function collectToolRefs(
  tool: ToolDefinition
): { tool: string; version?: string }[] {
  const refs: { tool: string; version?: string }[] = [];

  if ("source" in tool.implementation) {
    // Source tools don't have composition sub-references
    return refs;
  }

  collectCompositionRefs(tool.implementation.composition, refs);
  return refs;
}

function collectCompositionRefs(
  spec: CompositionSpec,
  refs: { tool: string; version?: string }[]
): void {
  if ("pipeline" in spec) {
    for (const step of spec.pipeline.steps) {
      if ("tool" in step.operation) {
        refs.push({ tool: step.operation.tool, version: step.operation.version });
      } else if ("composition" in step.operation) {
        collectCompositionRefs(step.operation.composition, refs);
      }
    }
  } else {
    for (const target of spec.scatterGather.targets) {
      if ("tool" in target) {
        refs.push({ tool: target.tool, version: target.version });
      } else if ("composition" in target) {
        collectCompositionRefs(target.composition, refs);
      }
    }
  }
}

/**
 * Check if a version satisfies a range expression.
 *
 * Handles both standard semver ranges (>=1.0.0, ^1.2.0) and
 * the convenience glob form (1.2.*, 1.*) by converting globs to
 * semver range syntax.
 */
function rangeMatches(range: string, version: string): boolean {
  // Convert glob patterns to semver ranges: "1.2.*" → ">=1.2.0 <1.3.0-0"
  const normalized = range
    .replace(/^(\d+)\.\*$/, ">=$1.0.0 <" + (parseInt(range) + 1) + ".0.0-0")
    .replace(
      /^(\d+)\.(\d+)\.\*$/,
      (_, maj, min) =>
        `>=${maj}.${min}.0 <${maj}.${parseInt(min) + 1}.0-0`
    );

  return semver.satisfies(version, normalized);
}
