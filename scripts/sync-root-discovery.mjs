import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = join(root, "tooling", "skills-distributions");
const pluginRoot = join(root, "plugins", "relay");
const mode = process.argv[2] ?? "--check";

if (!["--check", "--write"].includes(mode)) {
  throw new Error("usage: node scripts/sync-root-discovery.mjs [--check|--write]");
}

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const renderedJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const repoPath = (...parts) => parts.join("/");
const expected = new Map();

async function addFile(target, source) {
  expected.set(target, await readFile(source));
}

async function addJson(target, value) {
  expected.set(target, Buffer.from(renderedJson(value)));
}

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`canonical source must be a regular file: ${path}`);
  }
  return files.sort();
}

const codexSource = join(distributionRoot, "src", "plugins", "codex");
const version = (await json(
  join(distributionRoot, "src", "plugins", "version.json"),
)).version;

await addFile(
  ".agents/plugins/marketplace.json",
  join(codexSource, "marketplace.json"),
);

const cursorMarketplace = await json(
  join(distributionRoot, "src", "plugins", "cursor", "marketplace.json"),
);
assert.equal(cursorMarketplace.plugins.length, 1);
cursorMarketplace.plugins[0].source = "./plugins/relay";
await addJson(".cursor-plugin/marketplace.json", cursorMarketplace);

const claudeMarketplace = await json(
  join(root, "packages", "claude-code", ".claude-plugin", "marketplace.json"),
);
assert.equal(claudeMarketplace.plugins.length, 1);
claudeMarketplace.plugins[0].source = "./packages/claude-code/plugin";
await addJson(".claude-plugin/marketplace.json", claudeMarketplace);

await addFile(
  "plugins/relay/plugin.json",
  join(distributionRoot, "plugin.json"),
);
await addFile(
  "plugins/relay/mcp.json",
  join(distributionRoot, "mcp.json"),
);
await addFile(
  "plugins/relay/.mcp.json",
  join(codexSource, "mcp.json"),
);
await addFile(
  "plugins/relay/LICENSE",
  join(distributionRoot, "LICENSE"),
);

const codexPlugin = await json(join(codexSource, "plugin.json"));
codexPlugin.version = version;
codexPlugin.repository = "https://github.com/RelayMessenger/Relay-SDK";
await addJson("plugins/relay/.codex-plugin/plugin.json", codexPlugin);

const skillRoot = join(root, "skills", "relay");
for (const source of await walkFiles(skillRoot)) {
  const target = join(
    repoPath("plugins", "relay", "skills", "relay"),
    relative(skillRoot, source),
  ).split(sep).join("/");
  await addFile(target, source);
}

async function writeExpected() {
  await rm(pluginRoot, { recursive: true, force: true });
  for (const [target, content] of expected) {
    const path = join(root, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

async function generatedPluginFiles(directory) {
  return (await walkFiles(directory))
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
}

async function checkExpected() {
  for (const [target, expectedBytes] of expected) {
    const path = join(root, target);
    const info = await lstat(path);
    assert.ok(info.isFile(), `${target} must be a regular file`);
    assert.ok(!info.isSymbolicLink(), `${target} must not be a symlink`);
    assert.deepEqual(
      await readFile(path),
      expectedBytes,
      `${target} drifted; run npm run discovery:sync`,
    );
  }

  const expectedPluginFiles = [...expected.keys()]
    .filter((path) => path.startsWith("plugins/relay/"))
    .sort();
  assert.deepEqual(
    await generatedPluginFiles(pluginRoot),
    expectedPluginFiles,
    "plugins/relay contains files outside the canonical generated inventory",
  );

  const codexMarketplace = await json(
    join(root, ".agents", "plugins", "marketplace.json"),
  );
  const cursor = await json(
    join(root, ".cursor-plugin", "marketplace.json"),
  );
  const claude = await json(
    join(root, ".claude-plugin", "marketplace.json"),
  );
  const portablePlugin = await json(join(pluginRoot, "plugin.json"));
  const hostPlugin = await json(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
  );
  const packagePlugin = await json(
    join(root, "packages", "claude-code", "plugin", ".claude-plugin", "plugin.json"),
  );

  assert.equal(codexMarketplace.plugins[0].source.path, "./plugins/relay");
  assert.equal(cursor.plugins[0].source, "./plugins/relay");
  assert.equal(
    claude.plugins[0].source,
    "./packages/claude-code/plugin",
  );
  assert.equal(portablePlugin.name, "relay");
  assert.equal(portablePlugin.version, version);
  assert.equal(hostPlugin.name, "relay");
  assert.equal(hostPlugin.version, version);
  assert.equal(claude.plugins[0].name, packagePlugin.name);
  assert.equal(claude.plugins[0].version, packagePlugin.version);

  for (const source of [
    codexMarketplace.plugins[0].source.path,
    cursor.plugins[0].source,
    claude.plugins[0].source,
  ]) {
    assert.match(source, /^\.\//u);
    const resolved = resolve(root, source);
    assert.ok(
      resolved.startsWith(`${root}${sep}`),
      `marketplace source escapes Relay-SDK: ${source}`,
    );
    assert.ok((await lstat(resolved)).isDirectory(), `${source} is not a directory`);
  }
}

if (mode === "--write") await writeExpected();
await checkExpected();

console.log(
  `${mode === "--write" ? "synced and verified" : "verified"} `
    + `${expected.size} Relay-SDK root discovery files from canonical sources`,
);
