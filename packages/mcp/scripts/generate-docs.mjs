import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { parse } from "yaml";
const root = resolve(import.meta.dirname, "../../..");
const read = p => readFileSync(resolve(root, p), "utf8");
const clientText = read("packages/sdk/src/client.ts");
const typesText = read("packages/sdk/src/types.ts");
const contractText = read("contracts/relay-v1-openapi.yaml");
const contract = parse(contractText);
assert.equal(contract.paths["/v1/agents"]?.post, undefined, "Anonymous Agent registration is retired");
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
// Upgrades are source-only HTTP, not JSON REST resource methods.
// Same exclusion as scripts/validate-contract.mjs.
// The directory and agent-rating routes landed on the Server after the last
// contract carry; scripts/validate-contract.mjs lists them as source-only and
// this SDK carries no client method for them yet, so they have no docs entry.
const sourceOnlyPaths = new Set([
  "/v1/websocket", "/v1/calls/{callId}/media", "/v1/calls/{callId}/room",
  "/v1/directory", "/v1/contacts/{handle}/rating", "/v1/contacts/{handle}/ratings",
]);
const operationCount = Object.entries(contract.paths).reduce(
  (count, [path, item]) => count + (sourceOnlyPaths.has(path) ? 0 : Object.keys(item).filter(method => httpMethods.has(method)).length), 0,
);
const clientFile = ts.createSourceFile("client.ts", clientText, ts.ScriptTarget.Latest, true);
const typesFile = ts.createSourceFile("types.ts", typesText, ts.ScriptTarget.Latest, true);
const classes = new Map(clientFile.statements.filter(ts.isClassDeclaration).map(n => [n.name?.text, n]));
const types = new Map([...typesFile.statements, ...clientFile.statements].filter(n => ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)).map(n => [n.name.text, n.getText(n.getSourceFile())]));
const entries = [];
const skeleton = s => s.replace(/\$\{[^}]+\}|\{[^}]+\}/g, "{}");
function requestIn(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "request" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    const fields = Object.fromEntries(node.arguments[0].properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(clientFile), p.initializer]));
    if (fields.method && fields.path && ts.isStringLiteral(fields.method)) {
      const path = fields.path.getText(clientFile).slice(1, -1);
      const match = Object.entries(contract.paths).find(([p]) => skeleton(p) === skeleton(path));
      if (match) return { method: fields.method.text, path: match[0], operation: match[1][fields.method.text.toLowerCase()] };
    }
  }
  return ts.forEachChild(node, requestIn);
}
function definitions(text, depth = 0, seen = new Set()) {
  if (depth > 4) return [];
  const found = [];
  for (const name of text.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []) {
    if (seen.has(name) || !types.has(name)) continue;
    seen.add(name); const definition = types.get(name); found.push(definition, ...definitions(definition, depth + 1, seen));
  }
  return found;
}
function walk(className, prefix) {
  const declaration = classes.get(className); assert.ok(declaration, className);
  for (const member of declaration.members) {
    if ((member.name && ts.isPrivateIdentifier(member.name))
      || member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
    if (ts.isPropertyDeclaration(member) && member.type && classes.has(member.type.getText(clientFile))) walk(member.type.getText(clientFile), `${prefix}.${member.name.getText(clientFile)}`);
    if (!ts.isMethodDeclaration(member) || !member.body) continue;
    const request = requestIn(member.body); if (!request?.operation) continue;
    const isStatic = member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
    const method = `${isStatic ? className : prefix}.${member.name.getText(clientFile)}`;
    const parameters = member.parameters.map(p => p.getText(clientFile));
    const signature = `${method}(${parameters.join(", ")}): ${member.type?.getText(clientFile) ?? "unknown"}`;
    entries.push({ method, signature, parameters, httpMethod: request.method, path: request.path,
      operationId: request.operation.operationId, summary: request.operation.summary ?? request.operation.operationId,
      description: request.operation.description ?? "", definitions: definitions(signature),
      requestBody: request.operation.requestBody ?? null, executable: !isStatic,
      optionsIndex: member.parameters.findIndex(p =>
        ["RequestOptions", "CallCreateOptions", "PaymentRequestCreateOptions"].includes(p.type?.getText(clientFile) ?? "")),
    });
  }
}
walk("Relay", "client");
entries.sort((a,b) => a.method.localeCompare(b.method, "en"));
assert.equal(new Set(entries.map(x => `${x.httpMethod} ${x.path}`)).size, operationCount, "Every locked HTTP operation must have SDK documentation");
assert.ok(entries.filter(x => x.executable).every(x => x.optionsIndex >= 0));
const sha = s => createHash("sha256").update(s).digest("hex");
const source = { contract: sha(contractText), client: sha(clientText), types: sha(typesText) };
const output = `// Generated by scripts/generate-docs.mjs from the canonical SDK and OpenAPI. Do not edit.\nimport type { MethodDoc } from "./search-docs.js";\nexport const DOCS_SOURCE = ${JSON.stringify(source, null, 2)};\nexport const METHOD_DOCS: readonly MethodDoc[] = ${JSON.stringify(entries, null, 2)};\n`;
const target = resolve(root, "packages/mcp/src/generated-docs.ts");
if (process.argv.includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "MCP documentation drifted; run docs:generate");
console.log(`MCP docs: ${entries.length} SDK methods, ${operationCount} locked HTTP operations, sha256 ${source.contract}`);
