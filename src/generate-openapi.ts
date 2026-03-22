/**
 * Generates OpenAPI 3.1 spec from the canonical Zod definitions.
 *
 * Usage: npx tsx src/generate-openapi.ts > openapi.yaml
 *
 * Uses zod-to-json-schema for type conversion (handles recursive types
 * correctly) and constructs the OpenAPI document manually. The output
 * is a non-normative build artifact.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { stringify as yamlStringify } from "yaml";

import {
  ToolDefinition,
  AgentDefinition,
  SchemaDefinition,
  ServerDefinition,
} from "./schema.js";

import {
  CreateToolRequest,
  CreateToolResponse,
  RegistrationError,
  ListToolsParams,
  ListToolsResponse,
  GetToolResponse,
  DeleteToolResponse,
  DependentInfo,
  CreateAgentRequest,
  CreateAgentResponse,
  ListAgentsParams,
  ListAgentsResponse,
  CreateSchemaRequest,
  CreateSchemaResponse,
  ListSchemasResponse,
  CreateServerRequest,
  CreateServerResponse,
  ListServersResponse,
  ForwardLineageResult,
  ResolvedDependency,
  ReverseLineageResult,
  ApiError,
} from "./api.js";

// ---------------------------------------------------------------------------
// Generate JSON Schema definitions for all types
// ---------------------------------------------------------------------------

function schemaFor(zodSchema: any, name: string): Record<string, any> {
  const result = zodToJsonSchema(zodSchema, {
    name,
    $refStrategy: "root",
    target: "openApi3",
  });
  return result as Record<string, any>;
}

// Generate schemas and collect all $defs/definitions
const allDefinitions: Record<string, any> = {};

const typesToRegister = [
  // Data model
  ["ToolDefinition", ToolDefinition],
  ["AgentDefinition", AgentDefinition],
  ["SchemaDefinition", SchemaDefinition],
  ["ServerDefinition", ServerDefinition],
  // API request/response types
  ["CreateToolRequest", CreateToolRequest],
  ["CreateToolResponse", CreateToolResponse],
  ["RegistrationError", RegistrationError],
  ["ListToolsParams", ListToolsParams],
  ["ListToolsResponse", ListToolsResponse],
  ["GetToolResponse", GetToolResponse],
  ["DeleteToolResponse", DeleteToolResponse],
  ["DependentInfo", DependentInfo],
  ["CreateAgentRequest", CreateAgentRequest],
  ["CreateAgentResponse", CreateAgentResponse],
  ["ListAgentsParams", ListAgentsParams],
  ["ListAgentsResponse", ListAgentsResponse],
  ["CreateSchemaRequest", CreateSchemaRequest],
  ["CreateSchemaResponse", CreateSchemaResponse],
  ["ListSchemasResponse", ListSchemasResponse],
  ["CreateServerRequest", CreateServerRequest],
  ["CreateServerResponse", CreateServerResponse],
  ["ListServersResponse", ListServersResponse],
  ["ForwardLineageResult", ForwardLineageResult],
  ["ResolvedDependency", ResolvedDependency],
  ["ReverseLineageResult", ReverseLineageResult],
  ["ApiError", ApiError],
] as const;

for (const [name, schema] of typesToRegister) {
  const generated = schemaFor(schema, name);
  // Collect the named definition and any nested definitions
  if (generated.definitions) {
    Object.assign(allDefinitions, generated.definitions);
  }
}

// Rewrite internal $ref paths from #/definitions/X to #/components/schemas/X
function rewriteRefs(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(rewriteRefs);

  const result: any = {};
  for (const [key, val] of Object.entries(obj)) {
    if (
      key === "$ref" &&
      typeof val === "string" &&
      val.startsWith("#/definitions/")
    ) {
      result[key] = val.replace("#/definitions/", "#/components/schemas/");
    } else {
      result[key] = rewriteRefs(val);
    }
  }
  return result;
}

const schemas = rewriteRefs(allDefinitions);

// Helper to make a $ref
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

// ---------------------------------------------------------------------------
// Assemble OpenAPI document
// ---------------------------------------------------------------------------

const doc = {
  openapi: "3.1.0",
  info: {
    title: "Virtual Tools Registry API",
    version: "0.1.0",
    description:
      "Control plane API for the Virtual Tools registry. " +
      "Manages versioned tool, agent, schema, and server definitions " +
      "with lifecycle enforcement and lineage queries.\n\n" +
      "Generated from TypeScript type definitions (schema.ts, api.ts).\n" +
      "Requirements: docs/design/virtual-tools-requirements.md §4.1",
  },
  servers: [{ url: "http://localhost:8080", description: "Local development" }],

  paths: {
    // --- Tools (§4.1.1) ---
    "/tools": {
      post: {
        summary: "Register a tool",
        description:
          "Register a physical or virtual tool definition. " +
          "Static validation runs at registration time (§4.1.1).",
        tags: ["Tools"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreateToolRequest") } },
        },
        responses: {
          "201": {
            description: "Tool registered",
            content: {
              "application/json": { schema: ref("CreateToolResponse") },
            },
          },
          "400": {
            description: "Static validation failed",
            content: {
              "application/json": { schema: ref("RegistrationError") },
            },
          },
        },
      },
      get: {
        summary: "List tools",
        description:
          "Query tools by name, version, environment, server, or tags.",
        tags: ["Tools"],
        parameters: [
          {
            name: "name",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "version",
            in: "query",
            schema: { type: "string" },
            description: "SemVer range filter",
          },
          {
            name: "environment",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "server",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "tags",
            in: "query",
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: {
          "200": {
            description: "Tool list",
            content: {
              "application/json": { schema: ref("ListToolsResponse") },
            },
          },
        },
      },
    },

    "/tools/{name}": {
      get: {
        summary: "Get latest version of a tool",
        tags: ["Tools"],
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Tool definition",
            content: {
              "application/json": { schema: ref("GetToolResponse") },
            },
          },
          "404": {
            description: "Tool not found",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },

    "/tools/{name}/{version}": {
      get: {
        summary: "Get a specific tool version",
        tags: ["Tools"],
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Tool definition",
            content: {
              "application/json": { schema: ref("GetToolResponse") },
            },
          },
          "404": {
            description: "Tool or version not found",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
      delete: {
        summary: "Delete a tool version",
        description:
          "Lifecycle enforcement (§4.1.1): rejects if prod agents depend " +
          "on this version, warns if only stage agents depend on it.",
        tags: ["Tools"],
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Deletion result (may be blocked by dependents)",
            content: {
              "application/json": { schema: ref("DeleteToolResponse") },
            },
          },
          "404": {
            description: "Tool or version not found",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },

    // --- Agents (§4.1.2) ---
    "/agents": {
      post: {
        summary: "Register an agent",
        description:
          "Register an agent with versioned tool dependencies " +
          "and environment tag (§4.1.2).",
        tags: ["Agents"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: ref("CreateAgentRequest") },
          },
        },
        responses: {
          "201": {
            description: "Agent registered",
            content: {
              "application/json": { schema: ref("CreateAgentResponse") },
            },
          },
          "400": {
            description: "Validation error",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
      get: {
        summary: "List agents",
        tags: ["Agents"],
        parameters: [
          { name: "name", in: "query", schema: { type: "string" } },
          { name: "environment", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Agent list",
            content: {
              "application/json": { schema: ref("ListAgentsResponse") },
            },
          },
        },
      },
    },

    // --- Schemas (§4.1.3) ---
    "/schemas": {
      post: {
        summary: "Register a schema",
        description:
          "Register a named, versioned JSON Schema (§4.1.3). " +
          "Tools reference schemas via $ref.",
        tags: ["Schemas"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: ref("CreateSchemaRequest") },
          },
        },
        responses: {
          "201": {
            description: "Schema registered",
            content: {
              "application/json": { schema: ref("CreateSchemaResponse") },
            },
          },
          "400": {
            description: "Validation error",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
      get: {
        summary: "List schemas",
        tags: ["Schemas"],
        responses: {
          "200": {
            description: "Schema list",
            content: {
              "application/json": { schema: ref("ListSchemasResponse") },
            },
          },
        },
      },
    },

    // --- Servers (§4.1.4) ---
    "/servers": {
      post: {
        summary: "Register an MCP server",
        description:
          "Register a backend MCP server declaration (§4.1.4). " +
          "Used for SBOM tracking and lifecycle validation.",
        tags: ["Servers"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: ref("CreateServerRequest") },
          },
        },
        responses: {
          "201": {
            description: "Server registered",
            content: {
              "application/json": { schema: ref("CreateServerResponse") },
            },
          },
          "400": {
            description: "Validation error",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
      get: {
        summary: "List servers",
        tags: ["Servers"],
        responses: {
          "200": {
            description: "Server list",
            content: {
              "application/json": { schema: ref("ListServersResponse") },
            },
          },
        },
      },
    },

    // --- Lineage (§4.1.5) ---
    "/lineage/forward/{agentName}": {
      get: {
        summary: "Forward lineage query",
        description:
          "§4.1.5 Forward: Given agent X, return all " +
          "(tool, version) tuples it depends on.",
        tags: ["Lineage"],
        parameters: [
          {
            name: "agentName",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "agentVersion",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "environment",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Resolved dependencies",
            content: {
              "application/json": { schema: ref("ForwardLineageResult") },
            },
          },
          "404": {
            description: "Agent not found",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },

    "/lineage/reverse/{toolName}": {
      get: {
        summary: "Reverse lineage query",
        description:
          "§4.1.5 Reverse: Given tool Y (optionally version Z), " +
          "return all agents that depend on it.",
        tags: ["Lineage"],
        parameters: [
          {
            name: "toolName",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "version",
            in: "query",
            schema: { type: "string" },
            description: "Specific version to check",
          },
          {
            name: "environment",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Dependent agents",
            content: {
              "application/json": { schema: ref("ReverseLineageResult") },
            },
          },
          "404": {
            description: "Tool not found",
            content: { "application/json": { schema: ref("ApiError") } },
          },
        },
      },
    },
  },

  components: {
    schemas,
  },
};

console.log(yamlStringify(doc, { lineWidth: 120 }));
