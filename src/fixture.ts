/**
 * Test Fixture Format — language-agnostic behavioral spec for the data plane.
 *
 * Each fixture is a self-contained scenario: registry state, canned backend
 * responses, and expected behavior for tools/list and tools/call.
 *
 * Fixtures are stored as JSON files in fixtures/ and can be loaded by any
 * implementation (Rust, Python, TypeScript, Go) to verify conformance.
 */

import { z } from "zod";
import { Registry, JsonSchemaObject } from "./schema.js";

// ============================================================================
// Backend Mocks
// ============================================================================

/**
 * A canned response from a backend MCP tool.
 *
 * Either succeeds with a response object, or fails with an error message.
 * For tools called multiple times (e.g., in a pipeline with the same tool),
 * use the `responses` array — they are consumed in order.
 */
export const MockToolResponse = z.union([
  z.object({
    response: z.unknown(),
  }),
  z.object({
    error: z.string(),
  }),
]);

export type MockToolResponse = z.infer<typeof MockToolResponse>;

/**
 * A backend MCP tool's mock definition: its native schema plus canned response(s).
 */
export const MockTool = z.object({
  /** The tool's native inputSchema (what the backend expects). */
  inputSchema: JsonSchemaObject.optional(),
  /** Canned response (for tools called once). */
  response: z.unknown().optional(),
  /** Error response (simulates failure). */
  error: z.string().optional(),
});

export type MockTool = z.infer<typeof MockTool>;

/**
 * All mocked backend servers and their tools.
 *
 * Structure: { "server-name": { "tool-name": MockTool } }
 */
export const MockBackends = z.record(z.record(MockTool));

export type MockBackends = z.infer<typeof MockBackends>;

// ============================================================================
// Test Cases
// ============================================================================

/**
 * Expected backend call — verifies the data plane correctly transformed
 * the agent's input before forwarding to the backend.
 */
export const ExpectedBackendCall = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});

export type ExpectedBackendCall = z.infer<typeof ExpectedBackendCall>;

/**
 * A tools/list test case — verifies which tools are visible to a caller.
 */
export const ToolsListCase = z.object({
  caller: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  /** Tool names that MUST be in the response. */
  expectedTools: z.array(z.string()),
  /** Tool names that MUST NOT be in the response. */
  unexpectedTools: z.array(z.string()).optional(),
});

export type ToolsListCase = z.infer<typeof ToolsListCase>;

/**
 * A tools/call test case — verifies end-to-end tool execution behavior.
 */
export const ToolCallCase = z.object({
  /** The tool name the agent calls. */
  tool: z.string(),
  /** The arguments the agent sends. */
  arguments: z.unknown(),

  /**
   * Expected calls to backend tools (verifies input transformation).
   * Order matters for pipelines; order is unspecified for scatter-gather.
   */
  expectedBackendCalls: z.array(ExpectedBackendCall).optional(),

  /** Expected response returned to the agent (verifies output transformation). */
  expectedResponse: z.unknown(),
});

export type ToolCallCase = z.infer<typeof ToolCallCase>;

/**
 * A single test case within a fixture.
 */
export const TestCase = z.object({
  name: z.string(),
  description: z.string().optional(),
  toolsList: ToolsListCase.optional(),
  toolCall: ToolCallCase.optional(),
  /** Environment variables available during this case (for ${ENV.*} substitution). */
  env: z.record(z.string()).optional(),
});

export type TestCase = z.infer<typeof TestCase>;

// ============================================================================
// Fixture (top-level)
// ============================================================================

/**
 * A complete test fixture — everything needed to verify data plane behavior
 * for a specific scenario, without network access.
 */
export const TestFixture = z.object({
  name: z.string(),
  description: z.string(),
  /** Requirements section this fixture derives from. */
  requirementsRef: z.string().optional(),

  /** Registry snapshot the data plane loads. */
  registry: Registry,

  /** Canned backend responses. */
  backends: MockBackends,

  /** Test cases to run against this fixture. */
  cases: z.array(TestCase).min(1),
});

export type TestFixture = z.infer<typeof TestFixture>;
