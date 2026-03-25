/**
 * Tests that all fixture files conform to the fixture schema,
 * and that the registries within them conform to the data model.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TestFixture } from "./fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("Fixture file validation", () => {
  it("has fixture files to test", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    describe(file, () => {
      const raw = readFileSync(join(fixturesDir, file), "utf-8");
      const data = JSON.parse(raw);

      it("is valid JSON that conforms to the TestFixture schema", () => {
        const result = TestFixture.safeParse(data);
        if (!result.success) {
          // Show the actual Zod errors for debugging
          console.error(
            `Fixture ${file} failed validation:`,
            JSON.stringify(result.error.issues, null, 2)
          );
        }
        expect(result.success).toBe(true);
      });

      it("has cases array (may be empty for registry-only fixtures)", () => {
        expect(Array.isArray(data.cases)).toBe(true);
      });

      it("has a name and description", () => {
        expect(data.name).toBeTruthy();
        expect(data.description).toBeTruthy();
      });

      // Validate that toolCall cases reference tools that exist in the registry
      const toolNames = new Set(
        (data.registry?.tools ?? []).map((t: any) => t.name)
      );

      for (const testCase of data.cases ?? []) {
        if (testCase.toolCall) {
          it(`case "${testCase.name}" references a tool in the registry`, () => {
            expect(toolNames.has(testCase.toolCall.tool)).toBe(true);
          });
        }
      }
    });
  }
});

describe("Fixture content smoke tests", () => {
  it("B.1 has output transform with arrayMap (over + fields)", () => {
    const data = loadFixture("b1-output-transform.json");
    const tool = data.registry.tools[0];
    const resultsMapping = tool.outputTransform!.mappings.results as any;
    expect(resultsMapping.over).toBe("$.papers");
    expect(resultsMapping.fields.source.value).toBe("arxiv");
  });

  it("B.2 has scatter-gather with 4 targets, one optional", () => {
    const data = loadFixture("b2-scatter-gather.json");
    const sg = findTool(data, "multi_source_search");
    const comp = sg.implementation as any;
    const targets = comp.composition.scatterGather.targets;
    expect(targets).toHaveLength(4);
    expect(targets[2].optional).toBe(true);
    expect(targets[2].tool).toBe("normalized_github");
  });

  it("B.3 has 3-step pipeline with cross-step data binding", () => {
    const data = loadFixture("b3-pipeline.json");
    const tool = findTool(data, "store_research_finding");
    const comp = tool.implementation as any;
    const steps = comp.composition.pipeline.steps;
    expect(steps).toHaveLength(3);
    // Step 2 binds entity_id from step 1
    const step2input = steps[1].input.construct.fields.entity_id;
    expect(step2input.fromStep.stepId).toBe("create");
    expect(step2input.fromStep.path).toBe("$.entity.id");
  });

  it("B.4 has projection, defaults, and fieldMapping", () => {
    const data = loadFixture("b4-input-customization.json");
    const tool = findTool(data, "search");
    const source = (tool.implementation as any).source;
    expect(source.projection).toEqual(["region", "format"]);
    expect(source.defaults.api_key).toBe("${ENV.SEARCH_API_KEY}");
    expect(source.fieldMapping.search_term).toBe("query");
  });

  it("B.5 has agents with SemVer range dependencies", () => {
    const data = loadFixture("b5-lineage.json");
    expect(data.registry.agents).toHaveLength(2);
    const prodAgent = data.registry.agents![0];
    expect(prodAgent.environment).toBe("prod");
    expect(prodAgent.dependencies[0].versionRange).toBe("1.*");
  });

  it("E.1 has pipeline with output transform on the composition", () => {
    const data = loadFixture("e1-pipeline-with-transforms.json");
    const tool = findTool(data, "personalized_search");
    expect(tool.outputTransform).toBeDefined();
    expect(tool.outputTransform!.mappings.products).toEqual({
      path: "$.products",
    });
  });
});

// Helpers

function loadFixture(filename: string): any {
  return JSON.parse(readFileSync(join(fixturesDir, filename), "utf-8"));
}

function findTool(data: any, name: string): any {
  return data.registry.tools.find((t: any) => t.name === name);
}
