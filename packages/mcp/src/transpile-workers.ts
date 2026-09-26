import { parse, type Node } from "acorn";
import { transform } from "sucrase";

/**
 * The Workers build of `#transpile` (package.json "imports", "workerd"
 * condition). TypeScript's library cannot load on workerd: it probes for Node
 * while it evaluates and, under nodejs_compat, reaches `__filename`, which
 * workerd does not define; it is also ~9 MB. Sucrase strips TypeScript syntax
 * in plain JavaScript with no Node or WebAssembly dependency (~0.3 MB of
 * transform code), and acorn, a plain-JavaScript ECMAScript parser, gives the
 * AST that refuses module syntax exactly as transpile-node.ts does.
 */
const MODULE_NODES = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
]);

const hasModuleSyntax = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasModuleSyntax);
  if (!value || typeof value !== "object") return false;
  const node = value as Node & { meta?: { name?: string } };
  if (MODULE_NODES.has(node.type)) return true;
  if (node.type === "MetaProperty" && node.meta?.name === "import") return true;
  return Object.values(node).some(hasModuleSyntax);
};

export function compile(code: string): string {
  // keepUnusedImports: an import whose binding is unused is still an import,
  // and it must be refused, not silently dropped.
  const javascript = transform(code, {
    transforms: ["typescript"],
    disableESTransforms: true,
    keepUnusedImports: true,
  }).code;
  const program = parse(javascript, { ecmaVersion: "latest", sourceType: "module" });
  if (hasModuleSyntax(program)) {
    throw new Error("Imports and exports are not available. Define async function run(client) using the supplied client.");
  }
  return javascript;
}
