import Relay, { RelayPage } from "@relaymessenger/sdk";
import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import ts from "typescript";
import { METHOD_DOCS } from "./generated-docs.js";
import { redact, safeErrorMessage } from "./redact.js";

export interface ExecutionLimits { timeoutMs: number; memoryBytes: number; outputBytes: number }
const defaults: ExecutionLimits = { timeoutMs: 30_000, memoryBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024 };
const methods = new Map(METHOD_DOCS.filter(row => row.executable).map(row => [row.method.slice("client.".length), row]));

function compile(code: string): string {
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

export async function executeCode(code: string, client: Relay, secrets: readonly string[], overrides: Partial<ExecutionLimits> = {}): Promise<{ result: unknown; logs: Array<{ level: string; text: string }> }> {
  const limits = { ...defaults, ...overrides };
  const javascript = compile(code);
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + limits.timeoutMs;
  const abort = new AbortController();
  runtime.setInterruptHandler(() => Date.now() >= deadline || abort.signal.aborted);
  const vm = runtime.newContext();
  const promises: QuickJSDeferredPromise[] = [];
  const pages = new Map<number, RelayPage<unknown>>();
  const logs: Array<{ level: string; text: string }> = [];
  let outputBytes = 0;
  let disposed = false;
  let promiseHandle: QuickJSHandle | undefined;
  let outputError: Error | undefined;
  const limited = (text: string): string => {
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > limits.outputBytes) {
      outputError = new Error("Execution output exceeded the limit.");
      throw outputError;
    }
    return text;
  };
  const encode = (value: unknown): string => {
    const page = value instanceof RelayPage ? pages.size + 1 : undefined;
    if (page !== undefined) pages.set(page, value as RelayPage<unknown>);
    return limited(redact(JSON.stringify({ value: value ?? null, ...(page === undefined ? {} : { page }) }), secrets));
  };
  async function call(method: string, args: unknown[]): Promise<unknown> {
    if (abort.signal.aborted) throw new Error("Execution ended.");
    if (method === "__pageNext") {
      const page = pages.get(Number(args[0]));
      if (!page) throw new Error("Unknown page in this execution.");
      return page.getNextPage();
    }
    const doc = methods.get(method);
    if (!doc) throw new Error(`Unknown SDK method: client.${method}. Use search_docs to find a supported HTTP method.`);
    if (args.length > doc.optionsIndex + 1) throw new Error(`Too many arguments for client.${method}.`);
    let target: unknown = client;
    const parts = method.split(".");
    for (const part of parts.slice(0, -1)) target = (target as Record<string, unknown>)[part];
    const fn = (target as Record<string, unknown>)[parts.at(-1)!];
    if (typeof fn !== "function") throw new Error(`SDK method is unavailable: client.${method}`);
    const options = args[doc.optionsIndex];
    if (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) throw new Error("SDK request options must be a JSON object.");
    args[doc.optionsIndex] = { ...(options as Record<string, unknown> | undefined), signal: abort.signal };
    return Reflect.apply(fn, target, args);
  }
  const bridge = vm.newFunction("relaySdkCall", (methodHandle, argsHandle) => {
    const method = vm.getString(methodHandle);
    const args: unknown = JSON.parse(limited(vm.getString(argsHandle)));
    if (!Array.isArray(args)) throw new Error("SDK arguments must be a JSON array.");
    const promise = vm.newPromise(); promises.push(promise);
    void call(method, args).then(value => {
      if (disposed) return;
      const handle = vm.newString(encode(value));
      promise.resolve(handle); handle.dispose();
    }).catch(error => {
      if (disposed) return;
      const handle = vm.newError(safeErrorMessage(error, secrets));
      if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
        const status = vm.newNumber(error.status); vm.setProp(handle, "status", status); status.dispose();
      }
      promise.reject(handle); handle.dispose();
    });
    return promise.handle;
  });
  const logger = vm.newFunction("relayLog", (level, ...values) => {
    const text = limited(redact(values.map(value => {
      const data: unknown = vm.dump(value);
      return typeof data === "string" ? data : JSON.stringify(data);
    }).join(" "), secrets));
    logs.push({ level: vm.getString(level), text });
    return vm.undefined;
  });
  vm.setProp(vm.global, "__relayCall", bridge); bridge.dispose();
  vm.setProp(vm.global, "__relayLog", logger); logger.dispose();
  try {
    vm.unwrapResult(vm.evalCode(`
      ((call, log) => {
        const hydrate = envelope => {
          const value = envelope.value;
          if (envelope.page !== undefined && value !== null) {
            Object.defineProperties(value, {
              hasNextPage: { value: () => value.nextCursor !== null },
              getNextPage: { value: () => invoke('__pageNext', [envelope.page]) },
              [Symbol.asyncIterator]: { value: async function* () {
                let page = value;
                while (page) { yield* page.data; page = await page.getNextPage(); }
              } },
            });
          }
          return value;
        };
        const invoke = (method, args) => call(method, JSON.stringify(args)).then(text => hydrate(JSON.parse(text)));
        const client = Object.create(null);
        for (const method of ${JSON.stringify([...methods.keys()])}) {
          const parts = method.split('.'); let target = client;
          for (const part of parts.slice(0, -1)) target = target[part] ??= Object.create(null);
          target[parts[parts.length - 1]] = (...args) => invoke(method, args);
        }
        client.baseURL = ${JSON.stringify(client.baseURL ?? null)};
        const freeze = value => { for (const key of Object.keys(value)) if (value[key] && typeof value[key] === 'object') freeze(value[key]); return Object.freeze(value); };
        Object.defineProperty(globalThis, '__relayClient', { value: freeze(client) });
        Object.defineProperty(globalThis, 'console', { value: Object.freeze(Object.fromEntries(['log','info','warn','error','debug'].map(level => [level, (...values) => log(level, ...values)]))) });
      })(__relayCall, __relayLog);
      delete globalThis.__relayCall; delete globalThis.__relayLog;
    `, "relay-runtime.js")).dispose();
    promiseHandle = vm.unwrapResult(vm.evalCode(`(async () => {
      ${javascript}
      if (typeof run !== 'function') throw new Error('Define a top-level async function run(client).');
      const result = await run(globalThis.__relayClient);
      return JSON.stringify(result ?? null);
    })()`, "relay-execute.js"));
    for (;;) {
      if (Date.now() >= deadline) throw new Error("Execution timed out.");
      if (outputError) throw outputError;
      const jobs = runtime.executePendingJobs();
      if (jobs.error) { const error = vm.dump(jobs.error); jobs.error.dispose(); throw new Error(`Execution failed: ${JSON.stringify(error)}`); }
      const state = vm.getPromiseState(promiseHandle);
      if (state.type === "fulfilled") {
        const text = vm.getString(state.value); state.value.dispose();
        return { result: JSON.parse(limited(redact(text, secrets))) as unknown, logs };
      }
      if (state.type === "rejected") {
        const error = vm.dump(state.error) as { message?: string }; state.error.dispose();
        throw new Error(error?.message ?? JSON.stringify(error));
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  } finally {
    disposed = true;
    abort.abort(new Error("Execution ended."));
    promiseHandle?.dispose();
    for (const promise of promises) promise.dispose();
    vm.dispose(); runtime.dispose();
  }
}
