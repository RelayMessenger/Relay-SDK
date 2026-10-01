import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

// Authoring gate: the CLI's output is the job/command contract. A lost dependency
// edge, swallowed diff failure, or narrowed push would skip real checks. No
// existing test runs this boundary, and no test-only production seam is needed.
const cli = new URL('./ci-affected.mjs', import.meta.url).pathname;
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-affected-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, body = 'export const value = 1;\n') => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  };
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  for (const [name, dependencies] of [
    ['sdk', {}], ['pi', {'@relaymessenger/sdk': '*'}],
    ['cli', {'@relaymessenger/pi': '*'}], ['livekit', {'@relaymessenger/sdk': '*'}],
    ['chat-sdk-adapter', {}], ['openclaw', {'@relaymessenger/sdk': '*'}],
    ['claude-code', {'@relaymessenger/sdk': '*'}],
  ]) {
    put(`packages/${name}/package.json`, JSON.stringify({ name: `@relaymessenger/${name}`, dependencies }));
    put(`packages/${name}/src/index.ts`);
  }
  put('cookbook/send-a-message/package.json', JSON.stringify({name: 'recipe', dependencies: {'@relaymessenger/sdk': '*'}, scripts: {check: 'tsc', build: 'tsc', test: 'vitest run'}}));
  put('cookbook/send-a-message/src/index.ts');
  for (const name of ['relaymessenger', 'relaymessenger-pipecat', 'relaymessenger-livekit']) put(`python/${name}/src/index.py`, 'value = 1\n');
  put('cookbook/grok-voice-agent/pyproject.toml', '[project]\n');
  put('cookbook/grok-voice-agent/bot.py', 'value = 1\n');
  put('AGENTS.md', 'notes\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const change = (path, body) => { put(path, body); git('add', '.'); git('commit', '-qm', 'change'); };
  const plan = (env = {}) => JSON.parse(execFileSync(process.execPath, [cli], {cwd, encoding: 'utf8', env: {...process.env, EVENT: 'pull_request', BASE: base, HEAD: git('rev-parse', 'HEAD'), ...env}}));
  const list = flag => execFileSync(process.execPath, [cli, flag], {cwd, encoding: 'utf8', env: {...process.env, EVENT: 'pull_request', BASE: base, HEAD: git('rev-parse', 'HEAD')}}).trim();
  const outputs = () => {
    const path = join(cwd, 'github-output');
    execFileSync(process.execPath, [cli, '--github'], {cwd, encoding: 'utf8', env: {...process.env, EVENT: 'pull_request', BASE: base, HEAD: git('rev-parse', 'HEAD'), GITHUB_OUTPUT: path}});
    return Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map(line => line.split('=')));
  };
  return {cwd, git, put, base, change, plan, list, outputs};
}

test('leaf changes run only their workspace contract, with upstream builds', t => {
  const f = fixture(t); f.change('packages/livekit/src/index.ts', 'export const value = 2;');
  const p = f.plan();
  assert.equal(p.full, false); assert.deepEqual(p.workspaces, ['packages/livekit']);
  assert.deepEqual(p.python, []); assert.equal(p.release, false);
  assert.ok(p.commands.some(args => args.join(' ') === 'run build --workspace @relaymessenger/sdk'));
  assert.ok(p.commands.some(args => args.join(' ') === 'run validate:livekit'));
  assert.ok(!p.commands.some(args => args.includes('validate:cli')));
});

test('workspace dependency closure selects downstream consumers, not siblings', t => {
  const f = fixture(t); f.change('packages/pi/src/index.ts', 'export const value = 2;');
  assert.deepEqual(f.plan().workspaces, ['packages/pi', 'packages/cli']);
});

test('SDK changes reach all consumers and cookbooks; adapter changes reach SDK cross-contract tests', t => {
  const f = fixture(t); f.change('packages/sdk/src/index.ts', 'export const value = 2;');
  assert.ok(f.plan().workspaces.includes('cookbook/send-a-message'));
  assert.ok(f.plan().workspaces.includes('packages/cli'));
  f.git('checkout', '-qb', 'adapter', f.base);
  f.change('packages/chat-sdk-adapter/src/index.ts', 'export const value = 2;');
  assert.ok(f.plan().workspaces.includes('packages/sdk'));
});

test('Python SDK reaches its two local consumers; a leaf stays scoped', t => {
  const f = fixture(t); f.change('python/relaymessenger-livekit/src/index.py', 'value = 2\n');
  assert.deepEqual(f.plan().python, ['relaymessenger-livekit']);
  assert.deepEqual(f.plan().workspaces, []); assert.equal(f.plan().release, false);
  assert.deepEqual(f.outputs(), {code: 'true', full: 'false', node: 'false', 'python-sdk': 'false', 'python-pipecat': 'false', 'python-livekit': 'true', 'cookbook-python': 'false', cookbook: 'false', release: 'false'});
  f.change('python/relaymessenger/src/index.py', 'value = 2\n');
  assert.deepEqual(f.plan().python, ['relaymessenger', 'relaymessenger-pipecat', 'relaymessenger-livekit']);
});

test('Python cookbook edits do not run unrelated packages', t => {
  const f = fixture(t); f.change('cookbook/grok-voice-agent/bot.py', 'value = 2\n');
  const p = f.plan(); assert.deepEqual(p.pythonCookbooks, ['grok-voice-agent']);
  assert.deepEqual(p.python, []); assert.deepEqual(p.workspaces, []);
  assert.equal(f.list('--python-cookbooks'), 'cookbook/grok-voice-agent');
  assert.equal(f.list('--cookbooks'), '');
});

test('only known contributor notes skip heavy checks; product docs remain full', t => {
  const f = fixture(t); f.change('AGENTS.md', 'new notes\n');
  assert.equal(f.plan().code, false);
  f.change('packages/sdk/README.md', 'public docs\n');
  assert.equal(f.plan().full, true);
});

test('pushes and manual or merge-queue events always run full, regardless of diff', t => {
  const f = fixture(t); f.change('AGENTS.md', 'new notes\n');
  for (const [EVENT, GITHUB_REF] of [['push', 'refs/heads/staging'], ['push', 'refs/heads/main'], ['workflow_dispatch', ''], ['merge_group', '']]) {
    const p = f.plan({EVENT, GITHUB_REF});
    assert.equal(p.full, true); assert.equal(p.code, true);
    assert.deepEqual(p.commands, [['run', 'validate']]);
  }
});

test('unknown files, dependencies, deleted and renamed paths fail open to full', t => {
  const f = fixture(t);
  for (const path of ['new-area/code.ts', 'packages/sdk/package.json', 'python/relaymessenger/uv.lock', 'packages/sdk/scripts/new-check.mjs', 'packages/livekit/src/runtime.ts', 'packages/livekit/src/config.ts', 'packages/livekit/src/assets/data.json', 'packages/livekit/test/fixtures/event.ts', 'packages/livekit/src/settings.json', 'packages/livekit/src/vite.config.ts', 'python/relaymessenger/tests/conftest.py', 'packages/sdk/src/operations.ts']) {
    f.git('checkout', '-qb', `case-${Math.random()}`, f.base);
    f.change(path, path.endsWith('package.json') ? '{"name":"@relaymessenger/sdk"}' : 'changed\n');
    assert.equal(f.plan().full, true, path);
  }
  f.git('checkout', '-qb', 'deleted', f.base); f.git('rm', 'packages/livekit/src/index.ts'); f.git('commit', '-qm', 'delete');
  assert.equal(f.plan().full, true);
  f.git('checkout', '-qb', 'renamed', f.base); f.git('mv', 'packages/pi/src/index.ts', 'packages/pi/src/renamed.ts'); f.git('commit', '-qm', 'rename');
  assert.equal(f.plan().full, true);
});

test('missing history or empty diff cannot produce an empty green', t => {
  const f = fixture(t);
  assert.equal(f.plan().full, true);
  assert.equal(f.plan({BASE: 'not-a-commit'}).full, true);
  assert.equal(f.plan({BASE: ''}).full, true);
  f.change('packages/livekit/src/index.ts', 'export const value = 2;');
  assert.equal(f.plan({FORCE_FULL: 'true'}).full, true);
  assert.equal(f.plan({FORCE_FULL: 'unknown'}).full, true);
});

test('merge-base excludes base-only changes and accepts spaces/newlines in paths', t => {
  const f = fixture(t); f.change('packages/livekit/src/a b\nc.ts', 'export const value = 2;');
  const head = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'base-tip', f.base); f.change('unknown-on-base.txt', 'base only\n');
  const baseTip = f.git('rev-parse', 'HEAD'); f.git('checkout', '--detach', head);
  assert.deepEqual(f.plan({BASE: baseTip}).workspaces, ['packages/livekit']);
});

test('the command runner executes the selected gate and propagates its failure', t => {
  const f = fixture(t);
  const bin = join(f.cwd, 'bin'); mkdirSync(bin);
  const log = join(f.cwd, 'commands.log');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\nexit 7\n', {mode: 0o755});
  const result = spawnSync(process.execPath, [cli, '--run'], {cwd: f.cwd, encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, EVENT: 'push'}});
  assert.equal(result.status, 7);
  assert.equal(readFileSync(log, 'utf8'), 'run validate\n');
});
