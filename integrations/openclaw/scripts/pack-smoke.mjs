import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const tarballName = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
const tempRoot = mkdtempSync(join(tmpdir(), "relay-openclaw-pack-smoke-"));
const cleanSource = join(tempRoot, "source");
const packDir = join(tempRoot, "pack");
const installDir = join(tempRoot, "install");
const require = createRequire(import.meta.url);

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit" });
    return;
  }
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    stdio: "inherit",
  });
}

function findDependencyNodeModules() {
  const typescriptEntry = require.resolve("typescript");
  let current = dirname(typescriptEntry);
  while (current !== dirname(current)) {
    if (current.endsWith(`${join("node_modules", "typescript")}`)) {
      return dirname(current);
    }
    current = dirname(current);
  }
  throw new Error(`could not locate the installed TypeScript dependency from ${typescriptEntry}`);
}

function walkFiles(root, prefix = "") {
  const results = [];
  for (const name of readdirSync(root)) {
    const absolute = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (lstatSync(absolute).isDirectory()) {
      results.push(...walkFiles(absolute, relative));
    } else {
      results.push(relative);
    }
  }
  return results;
}

try {
  cpSync(packageDir, cleanSource, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(packageDir.length).replace(/^\//, "");
      return !(
        relative === "node_modules" ||
        relative.startsWith("node_modules/") ||
        relative === "dist" ||
        relative.startsWith("dist/") ||
        relative.endsWith(".tgz")
      );
    },
  });
  symlinkSync(findDependencyNodeModules(), join(cleanSource, "node_modules"), "dir");
  mkdirSync(packDir, { recursive: true });

  runNpm(["pack", "--pack-destination", packDir], cleanSource);
  const tarball = join(packDir, tarballName);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not create ${tarball}`);
  }

  runNpm(
    [
      "install",
      "--prefix",
      installDir,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
    ],
    tempRoot,
  );

  const installedPackage = join(
    installDir,
    "node_modules",
    ...packageJson.name.split("/"),
  );
  const installedOpenClaw = join(installDir, "node_modules", "openclaw");
  if (!existsSync(installedOpenClaw)) {
    const sourceOpenClaw = realpathSync(
      join(findDependencyNodeModules(), "openclaw"),
    );
    symlinkSync(sourceOpenClaw, installedOpenClaw, "dir");
  }

  const files = walkFiles(installedPackage);
  for (const required of [
    "LICENSE",
    "README.md",
    "openclaw.plugin.json",
    "dist/index.js",
    "dist/setup-entry.js",
    "dist/src/channel.js",
    "dist/src/lifecycle.js",
    "dist/src/security.js",
  ]) {
    if (!files.includes(required)) {
      throw new Error(`installed tarball is missing ${required}`);
    }
  }
  const forbidden = files.find((file) => file.endsWith(".test.ts") || file.endsWith(".test.js"));
  if (forbidden) {
    throw new Error(`installed tarball unexpectedly contains ${forbidden}`);
  }

  const entry = join(installedPackage, "dist", "index.js");
  const setupEntry = join(installedPackage, "dist", "setup-entry.js");
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "const [entry, setup] = process.argv.slice(1);",
        "const full = await import(entry);",
        "const light = await import(setup);",
        "if (full.default?.id !== 'relay') throw new Error('full entry did not load Relay');",
        "if (light.default?.plugin?.id !== 'relay') throw new Error('setup entry did not load Relay');",
      ].join("\n"),
      pathToFileURL(entry).href,
      pathToFileURL(setupEntry).href,
    ],
    { cwd: installDir, stdio: "inherit" },
  );

  console.log(
    `OpenClaw clean-pack smoke passed: ${tarballName}, ${files.length} installed files, full + setup entries loaded.`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
