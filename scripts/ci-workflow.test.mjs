import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import YAML from 'yaml';

const workflow = name => YAML.parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const ci = workflow('ci');
// Evaluate job conditions and concurrency keys with event fixtures, not source
// greps. These are independent scheduling contracts: a changed key can cancel
// a staging run even if every selector test passes.
const evaluate = (text, context) => text.replace(/\$\{\{(.*?)\}\}/gs, (_, expression) => String(runInNewContext(expression.replace(/outputs\.([\w-]+)/g, 'outputs["$1"]'), context)));
const context = (event, run, number, code = 'true') => ({
  github: {workflow: 'CI', event_name: event, run_id: run, head_ref: number ? 'feature' : '', event: {pull_request: {number, base: {sha: 'base'}, head: {sha: 'head'}}}},
  needs: {changes: {result: 'success', outputs: Object.fromEntries(['code', 'full', 'node', 'python-sdk', 'python-pipecat', 'python-livekit', 'cookbook-python', 'cookbook', 'release'].map(key => [key, code]))}},
  cancelled: () => false,
});

test('staging/main pushes cannot replace pending runs; only the same PR cancels its older run', () => {
  for (const name of ['staging', 'main']) {
    const a = context('push', 100); a.github.ref = `refs/heads/${name}`;
    const b = context('push', 101); b.github.ref = a.github.ref;
    assert.notEqual(evaluate(ci.concurrency.group, a), evaluate(ci.concurrency.group, b));
    assert.equal(evaluate(String(ci.concurrency['cancel-in-progress']), a), 'false');
  }
  assert.equal(evaluate(ci.concurrency.group, context('pull_request', 100, 9)), evaluate(ci.concurrency.group, context('pull_request', 101, 9)));
  assert.notEqual(evaluate(ci.concurrency.group, context('pull_request', 100, 9)), evaluate(ci.concurrency.group, context('pull_request', 101, 10)));
  assert.equal(evaluate(ci.concurrency['cancel-in-progress'], context('pull_request', 100, 9)), 'true');
  const native = workflow('agent-cli-platforms');
  assert.notEqual(evaluate(native.concurrency.group, context('push', 100)), evaluate(native.concurrency.group, context('push', 101)));
});

test('every full plan starts all check groups; absent selection outputs also run every group', () => {
  for (const value of ['true', undefined]) for (const [name, job] of Object.entries(ci.jobs)) {
    if (name === 'changes') continue;
    const fixture = context('push', 100, undefined, value);
    if (value === undefined) fixture.needs.changes.outputs = {};
    assert.equal(evaluate(job.if, fixture), 'true', name);
  }
  for (const [name, job] of Object.entries(ci.jobs)) {
    if (name === 'changes') continue;
    assert.equal(evaluate(job.if, context('push', 100, undefined, 'false')), 'true', `${name}: push cannot be filtered`);
    const failed = context('pull_request', 100, 9, 'false');
    failed.needs.changes.result = 'failure';
    assert.equal(evaluate(job.if, failed), 'true', `${name}: failed selector cannot skip`);
  }
  assert.deepEqual(ci.on.push.branches, ['main', 'staging']);
});

test('notes-only PRs keep the required validate check without running heavy jobs', () => {
  assert.ok(ci.jobs.validate);
  assert.equal(ci.on.pull_request, null);
  for (const [name, job] of Object.entries(ci.jobs)) {
    if (name !== 'changes') assert.equal(evaluate(job.if, context('pull_request', 100, 9, 'false')), 'false', name);
  }
});

test('Python leaf plan enables only its Python job and does not dispatch a second release suite', () => {
  const fixture = context('pull_request', 100, 9, 'false');
  fixture.needs.changes.outputs['python-livekit'] = 'true';
  assert.equal(evaluate(ci.jobs['python-livekit'].if, fixture), 'true');
  assert.equal(evaluate(ci.jobs['python-sdk'].if, fixture), 'false');
  assert.equal(evaluate(ci.jobs.validate.if, fixture), 'false');
  assert.equal(workflow('release-python').on.pull_request, undefined);
});

// Startup faults sit outside select()'s catch. Execute the workflow's actual
// shell entries with an unusable selector; record external tool invocations,
// without installing packages or running application code on this host.
function runShellEntries(t, job, fixture) {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-ci-bootstrap-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  for (const path of ['bin', 'scripts', 'temp', 'cookbook/one', 'cookbook/two']) mkdirSync(join(cwd, path), {recursive: true});
  writeFileSync(join(cwd, 'scripts/ci-affected.mjs'), 'throw new Error("selector bootstrap fault");\n');
  writeFileSync(join(cwd, 'bin/npm'), '#!/bin/sh\nprintf "npm:%s\\n" "$*" >> "$CALL_LOG"\n', {mode: 0o755});
  writeFileSync(join(cwd, 'bin/uv'), '#!/bin/sh\nprintf "uv:%s:%s\\n" "$(cat project.txt)" "$*" >> "$CALL_LOG"\n', {mode: 0o755});
  for (const name of ['one', 'two']) {
    writeFileSync(join(cwd, `cookbook/${name}/pyproject.toml`), '[project]\n');
    writeFileSync(join(cwd, `cookbook/${name}/project.txt`), name);
    writeFileSync(join(cwd, `cookbook/${name}/bot.py`), 'value = 1\n');
  }
  const log = join(cwd, 'calls');
  const admitted = step => !step.if || evaluate(step.if.includes('${{') ? step.if : '${{ ' + step.if + ' }}', fixture) === 'true';
  let result = {status: 0, stderr: ''};
  for (const step of job.steps.filter(step => step.run && admitted(step))) {
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([name, value]) => [name, evaluate(String(value), fixture)]));
    result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {cwd, encoding: 'utf8', env: {...process.env, ...env, PATH: `${cwd}/bin:${process.env.PATH}`, CALL_LOG: log, RUNNER_TEMP: join(cwd, 'temp')}});
    if (result.status !== 0) break;
  }
  return {...result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []};
}

function fullEntryFixtures() {
  const push = context('push', 100, undefined, 'false');
  const failed = context('pull_request', 101, 9, 'false');
  failed.needs.changes.result = 'failure';
  return [push, failed, context('pull_request', 102, 9, 'true')];
}

test('protected and FORCE_FULL validation invokes the original gate despite selector startup failure', t => {
  for (const fixture of fullEntryFixtures()) {
    const result = runShellEntries(t, ci.jobs.validate, fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.includes('npm:run validate'), result.calls.join('\n'));
  }
});

test('full Python cookbook execution reaches every project despite selector startup failure', t => {
  for (const fixture of fullEntryFixtures()) {
    const result = runShellEntries(t, ci.jobs['cookbook-python'], fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.filter(call => call.endsWith('run --locked pytest -q')).sort(), ['uv:one:run --locked pytest -q', 'uv:two:run --locked pytest -q']);
  }
});
