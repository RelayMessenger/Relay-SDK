#!/usr/bin/env node
/**
 * Refuse a build whose types have drifted from the published wire contract.
 *
 * `schemas/message-v2.schema.json` is owned by Relay-Server and generated from
 * real server responses. `src/types.ts` is written by hand against it, which
 * is fine right up until the schema grows a field and nobody notices, at which
 * point the SDK is quietly lying about the wire. This script is the thing that
 * notices.
 *
 * For each contract type it collects every property the schema publishes,
 * following `$ref` and the `oneOf` / `anyOf` / `allOf` branches that make up a
 * union, and asserts each one appears as a declared member in the TypeScript
 * source. It deliberately does not descend into a property's own value: the
 * question is "does `Part` publish a field this SDK never mentions", not "is
 * every nested type modelled".
 *
 * It also compares the vendored schema against Relay-Server's copy when
 * `RELAY_SERVER_DIR` names a checkout, so a stale vendored copy is caught
 * locally rather than by a consumer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(packageRoot, "schemas/message-v2.schema.json");
const typesPath = join(packageRoot, "src/types.ts");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const typesSource = readFileSync(typesPath, "utf8");

/** The types whose every published property must be modelled. */
const CONTRACT_TYPES = ["Part", "Message", "ReplyRef", "Reaction"];

/**
 * Properties a schema node publishes, following references and union
 * branches but never descending into a property's own subschema.
 */
function publishedProperties(node, seen = new Set()) {
  const names = new Set();
  if (!node || typeof node !== "object") return names;

  if (typeof node.$ref === "string") {
    const match = /^#\/\$defs\/(.+)$/.exec(node.$ref);
    assert.ok(match, `unsupported $ref in the schema: ${node.$ref}`);
    const name = match[1];
    if (seen.has(name)) return names;
    seen.add(name);
    const target = schema.$defs[name];
    assert.ok(target, `the schema references $defs/${name}, which is not defined`);
    for (const property of publishedProperties(target, seen)) names.add(property);
  }

  for (const property of Object.keys(node.properties ?? {})) names.add(property);

  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    for (const branch of node[keyword] ?? []) {
      for (const property of publishedProperties(branch, seen)) names.add(property);
    }
  }
  return names;
}

/**
 * True when `property` is declared as a member of some type in the source.
 * Matching the declaration rather than the bare word is what stops a name
 * that only appears in a comment from counting.
 */
function isModelled(property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s"'])${escaped}"?\\??\\s*:`, "m").test(typesSource);
}

let failures = 0;
for (const typeName of CONTRACT_TYPES) {
  const definition = schema.$defs[typeName];
  assert.ok(definition, `${typeName} is missing from ${schemaPath}`);
  const properties = [...publishedProperties(definition)].sort();
  assert.ok(
    properties.length > 0,
    `${typeName} published no properties, which means this check is not checking anything`,
  );
  const missing = properties.filter((property) => !isModelled(property));
  if (missing.length > 0) {
    failures += 1;
    console.error(
      `${typeName}: src/types.ts does not model ${missing.length} published `
      + `property(s): ${missing.join(", ")}`,
    );
  } else {
    console.log(`ok   ${typeName}: all ${properties.length} published properties are modelled`);
  }
}

// The vendored schema must stay byte-identical to the one Relay-Server owns.
const serverDir = process.env.RELAY_SERVER_DIR;
if (serverDir) {
  const ownerPath = join(serverDir, "schemas/message-v2.schema.json");
  const owner = readFileSync(ownerPath, "utf8");
  if (owner !== readFileSync(schemaPath, "utf8")) {
    failures += 1;
    console.error(
      `schemas/message-v2.schema.json has drifted from ${ownerPath}. `
      + "Relay-Server owns that file; copy it over rather than editing this one.",
    );
  } else {
    console.log("ok   the vendored schema matches Relay-Server's copy");
  }
} else {
  console.log("note RELAY_SERVER_DIR is unset; the vendored schema was not compared to its owner");
}

if (failures > 0) {
  console.error(
    `\n${failures} contract drift(s). Update src/types.ts to match `
    + "schemas/message-v2.schema.json, which Relay-Server owns.",
  );
  process.exit(1);
}
console.log("Types match the published message model v2 contract.");
