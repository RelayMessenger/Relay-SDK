#!/usr/bin/env node
// PR-only package-level selection. Keep each selected package's complete
// validation (including installed-copy checks); import-only test selection
// cannot see subprocesses, packed artifacts, or the Python SDK's local paths.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { releasePackages } from './release-packages.mjs';

const python = ['relaymessenger', 'relaymessenger-pipecat', 'relaymessenger-livekit'];
const notes = new Set(['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'scripts/agent-cli-platforms.md']);
const full = () => ({ code: true, full: true, workspaces: [], python, pythonCookbooks: [], cookbook: true, release: true, commands: [['run', 'validate']] });
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function select() {
  if (process.env.EVENT !== 'pull_request') return full();
  if (process.env.FORCE_FULL !== undefined && process.env.FORCE_FULL !== 'false') return full();
  if (!process.env.BASE || !process.env.HEAD) return full();
  // NUL delimiters preserve unusual filenames. --no-renames exposes removals;
  // a deleted file may have owned dependencies no longer visible at HEAD.
  const raw = execFileSync('git', ['diff', '--no-renames', '--name-status', '-z', `${process.env.BASE}...${process.env.HEAD}`, '--'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).split('\0');
  raw.pop();
  if (!raw.length || raw.length % 2) return full();
  const paths = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (!['A', 'M'].includes(raw[i])) return full();
    paths.push(raw[i + 1]);
  }
  const plan = {code: false, full: false, workspaces: [], python: [], pythonCookbooks: [], cookbook: false, release: false, commands: []};
  const manifests = new Map();
  for (const parent of ['packages', 'cookbook']) {
    for (const name of readdirSync(parent)) {
      const path = `${parent}/${name}`;
      if (existsSync(`${path}/package.json`)) manifests.set(path, json(`${path}/package.json`));
    }
  }
  const affected = new Set();
  const selectedPython = new Set();
  for (const path of paths) {
    if (notes.has(path)) continue;
    plan.code = true;
    // Python's test_websocket.py reads the TypeScript event inventory directly.
    if (path === 'packages/sdk/src/operations.ts') return full();
    if (/(^|[.\/-])(?:runtime|assets?|fixtures?|config|settings|conftest)(?:[.\/-]|$)/.test(path)) return full();
    // Manifests, locks, configs, scripts, public docs, shared contracts, and
    // unfamiliar paths have cross-package effects: deliberately run everything.
    const [parent, name, ...rest] = path.split('/');
    const local = rest.join('/');
    const directory = `${parent}/${name}`;
    if (manifests.has(directory) && /^(src|test|tests|examples)\/.+\.(ts|tsx|js)$/s.test(local)) {
      affected.add(directory);
    } else if (parent === 'python' && python.includes(name) && /^(src|tests|examples)\/.+\.py$/.test(local)) {
      selectedPython.add(name);
    } else if (parent === 'cookbook' && existsSync(join(directory, 'pyproject.toml')) && local.endsWith('.py')) {
      plan.pythonCookbooks.push(name);
    } else return full();
  }
  if (selectedPython.has('relaymessenger')) python.forEach(name => selectedPython.add(name));
  plan.python = python.filter(name => selectedPython.has(name));
  plan.pythonCookbooks = [...new Set(plan.pythonCookbooks)].sort();
  // The SDK payment test reads adapter types directly (not a manifest import).
  if (affected.has('packages/chat-sdk-adapter')) affected.add('packages/sdk');
  for (let size = -1; size !== affected.size;) {
    size = affected.size;
    const names = new Set([...affected].map(path => manifests.get(path).name));
    for (const [path, manifest] of manifests) {
      const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(field => Object.keys(manifest[field] ?? {}));
      if (dependencies.some(name => names.has(name))) affected.add(path);
    }
  }
  // Catalog order builds upstream packages before their consumers. Unknown
  // workspaces need an explicit validation owner before they can be scoped.
  const known = new Set(Object.values(releasePackages).map(entry => entry.directory));
  if ([...affected].some(path => path.startsWith('packages/') && !known.has(path))) return full();
  plan.workspaces = [...Object.values(releasePackages).map(entry => entry.directory), ...[...manifests.keys()].filter(path => path.startsWith('cookbook/')).sort()].filter(path => affected.has(path));
  plan.cookbook = plan.workspaces.some(path => path.startsWith('cookbook/'));
  // Release machinery/manifests take the full fallback. Source-only PRs keep
  // the selected package contract, not a second whole-repository rehearsal.
  if (!plan.workspaces.length) return plan;
  const run = name => plan.commands.push(['run', name]);
  // Shared contract/distribution guards remain whole: their inputs cross package
  // boundaries and their runtime is small compared with the package harnesses.
  for (const name of ['discovery:validate', 'sources:check', 'workflows:check']) run(name);
  if (!affected.has('packages/sdk')) plan.commands.push(['run', 'build', '--workspace', '@relaymessenger/sdk']);
  if (affected.has('packages/cli') && !affected.has('packages/pi')) plan.commands.push(['run', 'build', '--workspace', '@relaymessenger/pi']);
  for (const entry of Object.values(releasePackages)) if (affected.has(entry.directory)) run(entry.validate);
  for (const name of ['contract:check', 'validate:skills']) run(name);
  if (plan.cookbook) run('cookbook:link-check');
  for (const path of plan.workspaces.filter(path => path.startsWith('cookbook/'))) {
    const manifest = manifests.get(path);
    const scripts = manifest.scripts ?? {};
    if (scripts['test:all']) plan.commands.push(['run', 'test:all', '--workspace', manifest.name]);
    else for (const name of ['check', 'build', 'test']) {
      if (!scripts[name]) return full();
      plan.commands.push(['run', name, '--workspace', manifest.name]);
    }
  }
  run('proof:clean');
  return plan;
}

let plan;
try { plan = select(); }
catch (error) {
  console.error(`Affected selection unavailable (${error.code ?? error.name}); running full checks.`);
  plan = full();
}
const flags = process.argv.slice(2);
if (flags.includes('--cookbooks') || flags.includes('--python-cookbooks')) {
  const isPython = flags.includes('--python-cookbooks');
  const selected = plan.full
    ? readdirSync('cookbook').filter(name => existsSync(`cookbook/${name}/${isPython ? 'pyproject.toml' : 'package.json'}`)).map(name => `cookbook/${name}`)
    : isPython ? plan.pythonCookbooks.map(name => `cookbook/${name}`) : plan.workspaces.filter(path => path.startsWith('cookbook/'));
  if (selected.length) console.log(selected.join('\n'));
  process.exit(0);
}
if (flags.includes('--github')) {
  const outputs = {
    code: plan.code,
    full: plan.full,
    node: plan.full || plan.workspaces.length > 0,
    'python-sdk': plan.python.includes('relaymessenger'),
    'python-pipecat': plan.python.includes('relaymessenger-pipecat'),
    'python-livekit': plan.python.includes('relaymessenger-livekit'),
    'cookbook-python': plan.full || plan.pythonCookbooks.length > 0,
    cookbook: plan.cookbook,
    release: plan.release,
  };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
}
console.log(JSON.stringify(plan));
if (flags.includes('--run')) {
  for (const args of plan.commands) {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {stdio: 'inherit'});
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
