/**
 * `--verbose` prints each request this command makes, one line per request on
 * stderr, as `METHOD path status ms` (clig.dev "Arguments and flags": -v/
 * --verbose is the standard name; ledger row P21). The SDK takes a `fetch`, so
 * the wrapper sees every request the resource commands make and nothing else.
 */
export const verboseFetch = (
  base: typeof globalThis.fetch,
  write: (line: string) => void,
): typeof globalThis.fetch => async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = request?.url ?? (input instanceof URL ? input.href : String(input));
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url; }
  const started = performance.now();
  try {
    const response = await base(input, init);
    write(`${method} ${path} ${response.status} ${Math.round(performance.now() - started)}\n`);
    return response;
  } catch (error) {
    write(`${method} ${path} failed ${Math.round(performance.now() - started)}\n`);
    throw error;
  }
};
