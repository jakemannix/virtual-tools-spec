/**
 * Generates JSON Schema from the canonical Zod definitions.
 *
 * Usage: npx tsx src/generate-schema.ts > schema.json
 *
 * The output is a non-normative build artifact (the TypeScript definitions
 * in schema.ts are the source of truth), but useful for tooling that
 * consumes JSON Schema directly.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { Registry } from "./schema.js";

const jsonSchema = zodToJsonSchema(Registry, {
  name: "VirtualToolsRegistry",
  $refStrategy: "root",
});

console.log(JSON.stringify(jsonSchema, null, 2));
