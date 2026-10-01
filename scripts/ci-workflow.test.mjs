import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  github: {workflow: 'CI', event_name: event, run_id: run, head_ref: number ? 'feature' : '', event: {pull_request: {number}}},
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
