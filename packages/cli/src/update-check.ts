import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";

/**
 * The update notice, in the shape npm's update-notifier, gh, and vercel use:
 * read the registry's dist-tag at most once a day, cache it beside the config,
 * never block or fail the command on it, and print one notice on stderr.
 */

export const PACKAGE_NAME = "relaymessenger";
const REGISTRY = "https://registry.npmjs.org";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 1500;

export interface UpdateCheck {
  /** The installed version. */
  version: string;
  /** The dist-tag compared against: `staging` for a staging build, else `latest`. */
  tag: "latest" | "staging";
  /** The newest version from a fresh cache, known before any network call. */
  cached: string | undefined;
  /** The newest version, from the cache or the registry; undefined when unknown. */
  latest: Promise<string | undefined>;
}

export interface UpdateCheckOptions {
  version: string;
  cacheFile: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

export const distTagFor = (version: string): "latest" | "staging" =>
  /-staging\./u.test(version) ? "staging" : "latest";

const parse = (version: string): [number, number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/u.exec(version.trim());
  if (!match) return undefined;
  // A release outranks every prerelease of the same core (semver 11.3).
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4])];
};

/** True when `installed` is older than `latest`; false when either is unreadable. */
export const isOutdated = (installed: string, latest: string): boolean => {
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b) return false;
  for (let index = 0; index < 4; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]!;
  }
  return false;
};

interface CacheEntry { tag: string; latest: string; checked_at: number }

const readCache = (file: string): CacheEntry | undefined => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheEntry>;
    return typeof value.tag === "string" && typeof value.latest === "string" && typeof value.checked_at === "number"
      ? value as CacheEntry : undefined;
  } catch { return undefined; }
};

const disabled = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.NO_UPDATE_NOTIFIER || env.RELAY_NO_UPDATE_CHECK);

export const startUpdateCheck = (options: UpdateCheckOptions): UpdateCheck => {
  const env = options.env ?? process.env;
  const tag = distTagFor(options.version);
  const none: UpdateCheck = { version: options.version, tag, cached: undefined, latest: Promise.resolve(undefined) };
  if (disabled(env)) return none;
  const now = (options.now ?? Date.now)();
  const cache = readCache(options.cacheFile);
  if (cache && cache.tag === tag && now - cache.checked_at >= 0 && now - cache.checked_at < CHECK_INTERVAL_MS) {
    return { ...none, cached: cache.latest, latest: Promise.resolve(cache.latest) };
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const latest = (async (): Promise<string | undefined> => {
    try {
      const response = await fetcher(`${REGISTRY}/-/package/${PACKAGE_NAME}/dist-tags`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const tags = await response.json() as Record<string, unknown>;
      const value = tags[tag];
      if (typeof value !== "string" || !parse(value)) return undefined;
      try {
        mkdirSync(dirname(options.cacheFile), { recursive: true });
        writeFileSync(options.cacheFile, `${JSON.stringify({ tag, latest: value, checked_at: now })}\n`);
      } catch { /* A read-only home still gets the notice; it only loses the cache. */ }
      return value;
    } catch { return undefined; }
  })();
  return { ...none, latest };
};

const shellArg = (arg: string): string =>
  /^[\w@%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replace(/'/gu, `'\\''`)}'`;

/** How a person was running this copy: from npx's cache, or an install of their own. */
export const ranFromNpx = (script: string | undefined = process.argv[1]): boolean =>
  Boolean(script && script.includes(`${sep}_npx${sep}`));

/** The lines that tell a person this copy is old and exactly what to run instead. */
export const updateNotice = (check: Pick<UpdateCheck, "version" | "tag">, latest: string, argv: readonly string[], fromNpx = ranFromNpx()): string => {
  const command = ["npx", `${PACKAGE_NAME}@${check.tag}`, ...argv.map(shellArg)].join(" ");
  const lines = [
    `This relaymessenger is ${check.version}, which is out of date. The newest is ${latest}.`,
    `Run  ${command}`,
  ];
  if (!fromNpx) {
    lines.push(`An installed copy hides the newest one from npx. Run  npm uninstall -g ${PACKAGE_NAME}  or  npm install -g ${PACKAGE_NAME}@${check.tag}`);
  }
  return `${lines.join("\n")}\n`;
};

/** A refusal that says the route this copy called is gone: 404 or 410. */
export const staleRouteStatus = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 410;
};
