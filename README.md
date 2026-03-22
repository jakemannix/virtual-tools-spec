# @virtual-tools/spec

Canonical type definitions and API contract for the **Virtual Tools** system —
a config-driven abstraction layer between MCP tool authors and agent authors.

Virtual tools let agent authors customize how backend tools appear to their
agents (renaming, schema projection, default injection, multi-tool composition)
via declarative configuration, preserving MCP's N+M factorization while
improving eval quality. A central registry provides versioned lineage,
environment tags, and lifecycle enforcement for governance teams.

See [`docs/design/virtual-tools-requirements.md`](docs/design/virtual-tools-requirements.md)
for the full requirements specification.

## Quick start

```bash
npm install
npm test              # 56 acceptance tests
npm run build         # Compile TypeScript
npm run generate      # Regenerate schema.json + openapi.yaml
```

## Repository structure

```
src/
  schema.ts              # Source of truth — data model (Zod + TypeScript)
  api.ts                 # Source of truth — registry API contract types
  validate.ts            # Semantic validation (registration-time checks)
  registry.ts            # Reference control plane implementation
  dsl.ts                 # Authoring DSL — convenience constructors + compile
  fixture.ts             # Test fixture format schema (language-agnostic)
  schema.test.ts         # Data model acceptance tests (Appendix B scenarios)
  api.test.ts            # API contract type tests
  validate.test.ts       # Semantic validation tests
  registry.test.ts       # Registry service tests (B.5 scenarios + CRUD)
  dsl.test.ts            # Authoring DSL tests
  fixture.test.ts        # Fixture validation tests
  generate-schema.ts     # Generates schema.json from Zod definitions
  generate-openapi.ts    # Generates openapi.yaml from Zod definitions
fixtures/                # Language-agnostic behavioral test fixtures (JSON)
docs/design/
  virtual-tools-requirements.md   # Requirements specification (§ references)
schema.json              # (generated) JSON Schema — non-normative
openapi.yaml             # (generated) OpenAPI 3.1 — non-normative
```

## Conventions

TypeScript is the normative spec, following the same convention as
[MCP](https://github.com/modelcontextprotocol/modelcontextprotocol)
(TypeScript canonical, JSON Schema generated). OpenAPI is also generated,
following [A2A](https://github.com/a2aproject/A2A)'s pattern of generating
API docs from the canonical type definitions.

Every type and field in `schema.ts` and `api.ts` cites the section of the
requirements doc it derives from (e.g., `§4.2.1`). Fixture files reference
requirements sections via `requirementsRef`.

## What's in the spec

**schema.ts** — data model:
- `ToolDefinition` — source tools (1:1 backend mapping) and compositions
- `SourceTool` — projection, defaults, field mapping (§4.2)
- `OutputTransform` / `FieldExtraction` — simplified 3-form model (§4.3)
- `CompositionSpec` — pipeline and scatter-gather (§4.4)
- `CompositionProgressEvent` / `CompositionProgressNotification` — progress
  feedback during composition execution via MCP `notifications/progress` (§4.4.4)
- `AgentDefinition` — wraps A2A `AgentCard` + versioned tool dependencies +
  environment tags (§4.1.2)
- `SchemaDefinition`, `ServerDefinition` — registry metadata (§4.1.3-4)
- `Registry` — the snapshot consumed by the data plane

**api.ts** — registry API contract:
- CRUD for tools, agents, schemas, servers
- Lifecycle enforcement (DeleteToolResponse — blocked/warned/deleted)
- Registration validation errors (RegistrationError with violations)
- Forward/reverse lineage queries (§4.1.5)

**validate.ts** — semantic validation (registration-time checks):
- `validateTool(tool, registry)` — composition references resolve, step IDs
  unique, fromStep bindings valid, backend tool exists on server, server
  version satisfiable, field mapping consistency
- `validateAgent(agent, registry)` — dependencies resolve to existing tool
  versions, version ranges satisfiable, prod agents can't depend on
  stage-only tools, AgentCard structural checks
- `validateDelete(toolName, version, registry)` — DELETE lifecycle
  enforcement: prod dependents block, stage dependents warn, checks both
  agent and tool (composition) dependents, respects SemVer range satisfiability

All three return structured `RegistrationViolation` arrays with `{field, rule, message}`.

**registry.ts** — reference control plane implementation:
- `RegistryService` class — in-memory (optionally file-backed via snapshot
  serialization) implementation of the registry CRUD API
- Tool CRUD with duplicate detection and semantic validation on create
- Agent CRUD with dependency resolution and environment validation
- Schema and Server CRUD
- `deleteTool()` — full lifecycle enforcement via `validateDelete()`:
  prod dependents block, stage dependents warn, tool removed on success
- `forwardLineage()` — given an agent or tool, return resolved dependencies
- `reverseLineage()` — given a tool, return all agent and tool dependents
- `getSnapshot()` — export the full `Registry` for data plane consumption

**dsl.ts** — authoring convenience constructors for LLMs and WYSIWYG editors:
- `sourceTool(name, version, opts)` — 1:1 backend tool with projection,
  defaults, field mapping, output transform
- `scatterGatherTool(name, version, opts)` — parallel fan-out with aggregate
  shorthand strings (`"flatten"`, `"dedupe:$.url"`, `"limit:20"`)
- `pipelineTool(name, version, opts)` — sequential/DAG steps with input bindings
- `agentDef(card, opts)` — agent wrapping A2A AgentCard with dependency tuples
- `compile({ tools, agents })` — validate all tools and agents, return
  `Registry` or violations
- Autocomplete-friendly types: `AggregateShorthand` (template literal),
  `TargetShorthand`, `FieldShorthand`, `DependencyShorthand` ([tuple] form)

**fixtures/** — language-agnostic behavioral tests:
- `b1-output-transform.json` — ArrayMap normalization (arxiv papers → unified schema)
- `b2-scatter-gather.json` — 4-way fan-out with optional failure + aggregation
- `b3-pipeline.json` — cross-service pipeline with step data binding
- `b4-input-customization.json` — projection + defaults + field renaming
- `b5-lineage.json` — SemVer lifecycle enforcement + lineage queries
- `e1-pipeline-with-transforms.json` — ecommerce personalized search end-to-end

Each fixture contains registry state, canned backend responses, and expected
behavior. Any implementation (Rust, Python, Go) can load these to verify
conformance.

## What's not here yet

- **Reference data plane implementation** — a slow, correct TypeScript
  implementation of `resolveToolsList` and `resolveToolCall` that passes
  the fixtures
- **Agent identity / tool filtering fixtures** — types exist (§4.5) but no
  fixtures exercise them yet

## Origin

This spec was extracted from the virtual tools prototype in
[agentgatewaygastown](https://github.com/jakemannix/agentgatewaygastown),
a fork of [agentgateway](https://github.com/agentgateway/agentgateway). The
prototype includes a Rust data plane, TypeScript DSL (`@vmcp/dsl`), visual
builder, and working demos. This repo contains only the specification — types,
API contract, and behavioral test fixtures — independent of any runtime.

## License

Apache-2.0
