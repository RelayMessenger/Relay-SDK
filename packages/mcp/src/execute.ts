import Relay, { RelayPage } from "@relaymessenger/sdk";
import {
  RELEASE_SYNC, getQuickJS, newQuickJSWASMModule, newVariant,
  type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSWASMModule,
} from "quickjs-emscripten";
import { compile } from "#transpile";
import { METHOD_DOCS } from "./generated-docs.js";
import { redact, safeErrorMessage, withholdSecretFields } from "./redact.js";

export interface ExecutionLimits { timeoutMs: number; memoryBytes: number; outputBytes: number }
const defaults: ExecutionLimits = { timeoutMs: 30_000, memoryBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024 };
/**
 * Where QuickJS's WebAssembly comes from. Node reads the file itself. Workers
 * cannot compile WebAssembly from bytes at run time, so a Workers host imports
 * `@jitl/quickjs-wasmfile-release-sync/wasm` (a WebAssembly.Module) and passes
 * it here; it is loaded with quickjs-emscripten's newVariant over the same
 * RELEASE_SYNC variant getQuickJS() uses.
 */
/**
 * A sandbox that runs submitted code somewhere other than QuickJS. The shape is
 * Cloudflare Code Mode's `Executor` (@cloudflare/codemode, "Executor API"), so
 * a Workers host passes Code Mode's own `DynamicWorkerExecutor`, which runs the
 * code in a Dynamic Worker (Worker Loader) with outbound network blocked
 * (`globalOutbound: null`). The code reaches Relay only through the `relay`
 * provider below: its functions run on the host, where the SDK client, method
 * allow-list, output limits, and secret withholding live.
 */
export interface CodeExecutor {
  execute(
    code: string,
    providers: Array<{ name: string; fns: Record<string, (...args: never[]) => Promise<unknown>>; prelude?: string }>,
  ): Promise<{ result: unknown; error?: string; logs?: string[] }>;
}
export interface ExecutionRuntime {
  quickjsWasmModule?: WebAssembly.Module;
  /** Runs execute in this sandbox instead of QuickJS (see CodeExecutor). */
  executor?: CodeExecutor;
}
const loadedModules = new WeakMap<WebAssembly.Module, Promise<QuickJSWASMModule>>();
const loadQuickJS = (runtime: ExecutionRuntime): Promise<QuickJSWASMModule> => {
  const wasmModule = runtime.quickjsWasmModule;
  if (!wasmModule) return getQuickJS();
  let loaded = loadedModules.get(wasmModule);
  if (!loaded) {
    loaded = newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmModule }));
    loadedModules.set(wasmModule, loaded);
  }
  return loaded;
};
/**
 * The sandbox half of the SDK bridge, as source: given `call(method, argsJson)`
 * (a promise of the host's JSON envelope) and `log(level, ...values)`, it
 * builds the frozen `client` the submitted `run(client)` receives and routes
 * console output to `log`. Both sandboxes (QuickJS, a CodeExecutor) run it.
 */
const relayRuntime = (client: Relay): string => `((call, log) => {
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
})`;
const methods = new Map(METHOD_DOCS.filter(row => row.executable).map(row => [row.method.slice("client.".length), row]));

/**
 * The host half of the SDK bridge, shared by both sandboxes: the method
 * allow-list, the SDK call, the page registry, output limits, and secret
 * withholding. Nothing here runs inside the sandbox.
 */
const hostBridge = (client: Relay, secrets: readonly string[], limits: ExecutionLimits) => {
  const pages = new Map<number, RelayPage<unknown>>();
  const logs: Array<{ level: string; text: string }> = [];
  const abort = new AbortController();
  let outputBytes = 0;
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
    // Secret fields are withheld on the host, before a value enters the
    // sandbox, so neither submitted code nor its result or logs can see them.
    return limited(redact(JSON.stringify({ value: value ?? null, ...(page === undefined ? {} : { page }) }, withholdSecretFields), secrets));
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
  const log = (level: string, text: string): void => {
    logs.push({ level, text: limited(redact(text, secrets)) });
  };
  const result = (text: string): unknown => JSON.parse(limited(redact(text, secrets)));
  return { call, encode, limited, log, logs, result, abort, outputError: () => outputError };
};

/** The code a CodeExecutor runs: the submitted program, then run(client). */
const executorProgram = (javascript: string): string => `async () => {
${javascript}
if (typeof run !== 'function') throw new Error('Define a top-level async function run(client).');
const __result = await run(globalThis.__relayClient);
await Promise.all(globalThis.__relayPendingLogs);
return JSON.stringify(__result ?? null);
}`;

/**
 * Its prelude: the same runtime QuickJS gets, wired to the `relay` provider.
 * An error envelope from the host becomes an Error with the SDK's `status`, as
 * in QuickJS. Log lines are sent as they happen and awaited before the result.
 */
const executorPrelude = (client: Relay): string => `
Object.defineProperty(globalThis, '__relayPendingLogs', { value: [] });
(${relayRuntime(client)})(
  async (method, argsJson) => {
    const text = await relay.call(method, argsJson);
    const envelope = JSON.parse(text);
    if (envelope.error) {
      const error = new Error(envelope.error.message);
      if (typeof envelope.error.status === 'number') error.status = envelope.error.status;
      throw error;
    }
    return text;
  },
  (level, ...values) => {
    globalThis.__relayPendingLogs.push(relay.log(level, values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')));
  },
);`;

const executeInExecutor = async (
  executor: CodeExecutor,
  javascript: string,
  client: Relay,
  secrets: readonly string[],
  limits: ExecutionLimits,
): Promise<{ result: unknown; logs: Array<{ level: string; text: string }> }> => {
  const host = hostBridge(client, secrets, limits);
  const relay = {
    call: async (method: string, argsJson: string): Promise<string> => {
      try {
        const args: unknown = JSON.parse(host.limited(argsJson));
        if (!Array.isArray(args)) throw new Error("SDK arguments must be a JSON array.");
        return host.encode(await host.call(method, args));
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
        return JSON.stringify({ error: { message: safeErrorMessage(error, secrets), ...(status === undefined ? {} : { status }) } });
      }
    },
    log: async (level: string, text: string): Promise<void> => { host.log(level, text); },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      executor.execute(executorProgram(javascript), [{ name: "relay", fns: relay, prelude: executorPrelude(client) }]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Execution timed out.")), limits.timeoutMs); }),
    ]);
    const outputError = host.outputError();
    if (outputError) throw outputError;
    if (outcome.error !== undefined) throw new Error(outcome.error);
    if (typeof outcome.result !== "string") throw new Error("Execution returned no result.");
    return { result: host.result(outcome.result), logs: host.logs };
  } finally {
    clearTimeout(timer);
    host.abort.abort(new Error("Execution ended."));
  }
};

export async function executeCode(code: string, client: Relay, secrets: readonly string[], overrides: Partial<ExecutionLimits> = {}, runtimeOptions: ExecutionRuntime = {}): Promise<{ result: unknown; logs: Array<{ level: string; text: string }> }> {
  const limits = { ...defaults, ...overrides };
  const javascript = compile(code);
  if (runtimeOptions.executor) return executeInExecutor(runtimeOptions.executor, javascript, client, secrets, limits);
  const QuickJS = await loadQuickJS(runtimeOptions);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + limits.timeoutMs;
  const host = hostBridge(client, secrets, limits);
  const { abort, limited, logs } = host;
  runtime.setInterruptHandler(() => Date.now() >= deadline || abort.signal.aborted);
  const vm = runtime.newContext();
  const promises: QuickJSDeferredPromise[] = [];
  let disposed = false;
  let promiseHandle: QuickJSHandle | undefined;
  const call = host.call;
  const encode = host.encode;
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
      (${relayRuntime(client)})(__relayCall, __relayLog);
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
      const outputError = host.outputError();
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
