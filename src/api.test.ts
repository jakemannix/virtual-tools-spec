/**
 * Tests for the registry API contract types.
 */

import { describe, it, expect } from "vitest";
import {
  CreateToolRequest,
  RegistrationError,
  DeleteToolResponse,
  ForwardLineageResult,
  ReverseLineageResult,
  DependentInfo,
  ListToolsParams,
} from "./api.js";

describe("Tool API types", () => {
  it("validates a CreateToolRequest", () => {
    const req: CreateToolRequest = {
      tool: {
        name: "search",
        version: "1.0.0",
        implementation: {
          source: { server: "search-service", tool: "raw_search" },
        },
      },
    };
    expect(CreateToolRequest.safeParse(req).success).toBe(true);
  });

  it("validates a RegistrationError with violations", () => {
    const err: RegistrationError = {
      error: "registration_error",
      message: "Static validation failed",
      violations: [
        {
          field: "source.projection",
          rule: "required_field_needs_default",
          message:
            "Field 'api_key' is required but projected without a default",
        },
      ],
    };
    expect(RegistrationError.safeParse(err).success).toBe(true);
  });

  it("validates a successful delete response", () => {
    const resp: DeleteToolResponse = { deleted: true };
    expect(DeleteToolResponse.safeParse(resp).success).toBe(true);
  });

  it("validates a delete response with stage warnings (agent dependent)", () => {
    const resp: DeleteToolResponse = {
      deleted: true,
      warnings: [
        {
          type: "agent",
          name: "test-agent",
          version: "1.0.0",
          environment: "stage",
          versionRange: "1.0.0",
        },
      ],
    };
    expect(DeleteToolResponse.safeParse(resp).success).toBe(true);
  });

  it("validates a blocked delete with both agent and tool dependents", () => {
    const resp: DeleteToolResponse = {
      deleted: false,
      reason:
        "Cannot delete: prod dependents exist",
      dependents: [
        {
          type: "agent",
          name: "research-agent",
          version: "1.0.0",
          environment: "prod",
          versionRange: "1.*",
          contact: "ml-team@example.com",
        },
        {
          type: "tool",
          name: "multi_source_search",
          version: "1.0.0",
          environment: "prod",
          versionRange: "1.*",
        },
      ],
    };
    expect(DeleteToolResponse.safeParse(resp).success).toBe(true);
  });

  it("validates list tools query params", () => {
    const params: ListToolsParams = {
      environment: "prod",
      tags: ["search", "ml"],
    };
    expect(ListToolsParams.safeParse(params).success).toBe(true);
  });
});

describe("Lineage API types", () => {
  it("validates forward lineage for an agent", () => {
    const result: ForwardLineageResult = {
      type: "agent",
      name: "research-agent",
      dependencies: [
        {
          tool: "search",
          versionRange: "1.*",
          resolvedVersions: ["1.0.0", "1.1.0"],
        },
        {
          tool: "fetch",
          versionRange: ">=2.0.0",
          resolvedVersions: ["2.0.0"],
        },
      ],
    };
    expect(ForwardLineageResult.safeParse(result).success).toBe(true);
  });

  it("validates forward lineage for a tool (composition dependencies)", () => {
    const result: ForwardLineageResult = {
      type: "tool",
      name: "multi_source_search",
      dependencies: [
        {
          tool: "normalized_arxiv",
          versionRange: "1.*",
          resolvedVersions: ["1.0.0"],
        },
        {
          tool: "normalized_github",
          versionRange: "1.*",
          resolvedVersions: ["1.0.0"],
        },
      ],
    };
    expect(ForwardLineageResult.safeParse(result).success).toBe(true);
  });

  it("validates reverse lineage with agent and tool dependents", () => {
    const result: ReverseLineageResult = {
      tool: "normalized_arxiv",
      version: "1.0.0",
      dependents: [
        {
          type: "agent",
          name: "research-agent",
          version: "1.0.0",
          environment: "prod",
          versionRange: "1.*",
        },
        {
          type: "tool",
          name: "multi_source_search",
          version: "1.0.0",
          environment: "prod",
          versionRange: "1.*",
        },
      ],
    };
    expect(ReverseLineageResult.safeParse(result).success).toBe(true);
  });

  it("validates a reverse lineage with no dependents", () => {
    const result: ReverseLineageResult = {
      tool: "unused-tool",
      dependents: [],
    };
    expect(ReverseLineageResult.safeParse(result).success).toBe(true);
  });
});
