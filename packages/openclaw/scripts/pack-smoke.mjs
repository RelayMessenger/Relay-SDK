import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const archiveName = `${packageJson.name
  .replace(/^@/u, "")
  .replaceAll("/", "-")}-${packageJson.version}.tgz`;
const temp = mkdtempSync(join(tmpdir(), "relay-openclaw-pack-"));
const source = join(temp, "source");
const pack = join(temp, "pack");
const install = join(temp, "install");
const require = createRequire(import.meta.url);

function packageRoot(specifier, expectedName) {
  let current = dirname(require.resolve(specifier));
  while (current !== dirname(current)) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, "utf8"));
      if (value.name === expectedName) return current;
    }
    current = dirname(current);
  }
  throw new Error(`could not locate ${expectedName} package root`);
}

function walk(path, prefix = "") {
  return readdirSync(path).flatMap((name) => {
    const absolute = join(path, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    return lstatSync(absolute).isDirectory()
      ? walk(absolute, relative)
      : [relative];
  });
}

function npm(args, cwd) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=768",
    },
  });
}

try {
  cpSync(root, source, {
    recursive: true,
    filter: (path) => {
      const relative = path.slice(root.length).replace(/^\//u, "");
      return !(
        relative === ".git" ||
        relative.startsWith(".git/") ||
        relative === ".contract" ||
        relative.startsWith(".contract/") ||
        relative === ".release" ||
        relative.startsWith(".release/") ||
        relative === ".daytona-receipts" ||
        relative.startsWith(".daytona-receipts/") ||
        relative === "node_modules" ||
        relative.startsWith("node_modules/") ||
        relative.endsWith(".tgz")
      );
    },
  });
  mkdirSync(pack, { recursive: true });
  npm(
    ["pack", ".", "--ignore-scripts", "--pack-destination", pack],
    source,
  );

  const archive = join(pack, archiveName);
  if (!existsSync(archive)) throw new Error(`missing npm pack archive ${archive}`);
  npm(
    [
      "install",
      "--prefix",
      install,
      "--ignore-scripts",
      "--omit=optional",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      archive,
    ],
    temp,
  );

  const installed = join(
    install,
    "node_modules",
    ...packageJson.name.split("/"),
  );
  const installedOpenClaw = join(install, "node_modules", "openclaw");
  if (!existsSync(installedOpenClaw)) {
    symlinkSync(
      realpathSync(packageRoot("openclaw", "openclaw")),
      installedOpenClaw,
      "dir",
    );
  }
  const files = walk(installed);
  for (const required of [
    "LICENSE",
    "README.md",
    "contracts/relay-v1.lock.json",
    "contracts/relay-sdk-0.3.0-staging.4.registry.json",
    "openclaw.plugin.json",
    "dist/index.js",
    "dist/setup-entry.js",
    "dist/src/channel.js",
    "dist/src/gateway.js",
    "dist/src/ingress.js",
    "dist/src/state.js",
  ]) {
    if (!files.includes(required)) {
      throw new Error(`installed package is missing ${required}`);
    }
  }
  const forbidden = files.find(
    (file) =>
      file.endsWith(".test.ts") ||
      file.endsWith(".test.js") ||
      file.includes("poll-loop") ||
      file.endsWith("/client.ts") ||
      file.endsWith("/client.js"),
  );
  if (forbidden) {
    throw new Error(`installed package contains forbidden file ${forbidden}`);
  }

  const installedRequire = createRequire(join(installed, "package.json"));
  const sdkPackage = installedRequire("@relaymessenger/sdk/package.json");
  if (sdkPackage.version !== packageJson.dependencies["@relaymessenger/sdk"]) {
    throw new Error(
      `installed SDK ${sdkPackage.version} does not match ${packageJson.dependencies["@relaymessenger/sdk"]}`,
    );
  }

  const entry = pathToFileURL(join(installed, "dist", "index.js")).href;
  const setup = pathToFileURL(join(installed, "dist", "setup-entry.js")).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "const [entry, setup] = process.argv.slice(1);",
        "const full = await import(entry);",
        "const light = await import(setup);",
        "if (full.default?.id !== 'relay') throw new Error('full Relay entry did not load');",
        "if (full.default?.channelPlugin?.message?.id !== 'relay') throw new Error('Relay message adapter is missing');",
        "if (light.default?.plugin?.id !== 'relay') throw new Error('Relay setup entry did not load');",
      ].join("\n"),
      entry,
      setup,
    ],
    { cwd: install, stdio: "inherit" },
  );

  console.log(
    `Relay OpenClaw clean npm pack passed: ${archiveName}, ${files.length} installed files.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 10 });
}
