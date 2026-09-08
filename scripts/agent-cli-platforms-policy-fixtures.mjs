import assert from 'node:assert/strict';
import YAML from 'yaml';
import { NATIVE_WORKFLOW, validateRunnerPolicy } from './agent-cli-platforms-policy.mjs';
export const negativePolicyFixtures = [
  ['unapproved feature branch', w => { w.on.push.branches.push('test/unapproved'); }],
  ['cancel another run', w => { w.concurrency['cancel-in-progress'] = true; }],
  ['frozen audit on other branches', w => { delete w.jobs.native.steps.find(s => s.run === 'node scripts/agent-cli-platforms-published.mjs').if; }],
  ['hosted Linux in matrix', w => { w.jobs.native.strategy.matrix.os[0] = 'ubuntu-latest'; }],
  ['extra matrix dimension', w => { w.jobs.native.strategy.matrix.node = [22,24]; }],
  ['matrix include escape', w => { w.jobs.native.strategy.matrix.include = [{ os: 'ubuntu-latest' }]; }],
  ['extra job', w => { w.jobs.linux = { 'runs-on': 'ubuntu-latest', steps: [{run:'npm ci'}] }; }],
  ['direct runner escape', w => { w.jobs.native['runs-on'] = 'ubuntu-latest'; }],
  ['main push', w => { w.on.push.branches.push('main'); }],
  ['tag push', w => { w.on.push.tags = ['*']; }],
  ['additional trigger', w => { w.on.pull_request_target = {}; }],
  ['unguarded dispatch', w => { delete w.jobs.native.if; }],
  ['write permission', w => { w.permissions['id-token'] = 'write'; }],
  ['job privilege override', w => { w.jobs.native.permissions = { contents:'write' }; }],
  ['deployment environment', w => { w.jobs.native.environment = 'production'; }],
  ['publish step', w => { w.jobs.native.steps.push({run:'npm publish --tag staging'}); }],
  ['compound command', w => { w.jobs.native.steps.push({run:'npm ci; npm publish'}); }],
  ['secret injection', w => { w.jobs.native.steps[0].env = { NPM_TOKEN:'${{ secrets.NPM_TOKEN }}' }; }],
  ['main checkout', w => { w.jobs.native.steps.find(s=>s.uses?.startsWith('actions/checkout@')).with.ref = 'main'; }],
];
export function verifyPolicyFixtures(text) {
  validateRunnerPolicy(NATIVE_WORKFLOW, text);
  for (const [label, mutate] of negativePolicyFixtures) {
    const value = YAML.parse(text); mutate(value);
    assert.throws(() => validateRunnerPolicy(NATIVE_WORKFLOW, YAML.stringify(value)), undefined, label);
  }
  validateRunnerPolicy('.github/workflows/existing.yml', 'jobs:\n  a:\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n');
  assert.throws(() => validateRunnerPolicy('.github/workflows/existing.yml', text), /Blacksmith/);
}
