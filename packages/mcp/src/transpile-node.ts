import ts from "typescript";

/**
 * Turn submitted TypeScript or JavaScript into a script QuickJS can run, with
 * TypeScript's own transpiler. Node resolves `#transpile` here; a Workers host
 * resolves transpile-workers.ts instead (package.json "imports", "workerd"
 * condition), because TypeScript's library probes for Node as it evaluates and
 * crashes on workerd (`__filename is not defined`), and it is ~9 MB.
 */
export function compile(code: string): string {
  const file = ts.createSourceFile("relay-execute.ts", code, ts.ScriptTarget.Latest, true);
  let invalidModule = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)
      || ts.isExportAssignment(node) || node.kind === ts.SyntaxKind.ImportKeyword
      || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(x => x.kind === ts.SyntaxKind.ExportKeyword))) invalidModule = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (invalidModule) throw new Error("Imports and exports are not available. Define async function run(client) using the supplied client.");
  const compiled = ts.transpileModule(code, { fileName: "relay-execute.ts", reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true } });
  const errors = (compiled.diagnostics ?? []).filter(x => x.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(errors.map(x => ts.flattenDiagnosticMessageText(x.messageText, "\n")).join("\n"));
  return compiled.outputText;
}
