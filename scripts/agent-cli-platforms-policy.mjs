import assert from 'node:assert/strict';
import YAML from 'yaml';
export const NATIVE_WORKFLOW = '.github/workflows/agent-cli-platforms.yml';
export const NATIVE_REF_GUARD = "github.ref == 'refs/heads/staging' || github.ref == 'refs/heads/agent-cli-verification-20260908' || github.ref == 'refs/heads/test/staging-e2e-cli-20260908'";
const commands = new Set([
  'git config --global core.autocrlf false',
  'npm install --global npm@11.19.1 --no-audit --no-fund',
  'npm ci',
  './scripts/agent-cli-platforms-windows-probe.ps1',
  'node --test scripts/agent-cli-platforms-staging.test.mjs',
  'node --test scripts/agent-cli-platforms-policy.test.mjs scripts/agent-cli-platforms-registry.test.mjs',
  'node scripts/agent-cli-platforms.mjs',
  'node scripts/agent-cli-platforms-published.mjs',
]);
export function validateRunnerPolicy(source, text) {
  if (source.replaceAll('\\', '/') !== NATIVE_WORKFLOW) {
    const labels = [...text.matchAll(/runs-on:\s*(\S+)/gu)].map(([, label]) => label);
    assert.ok(labels.length > 0, `${source} declares no runner`);
    for (const label of labels) assert.match(label, /^blacksmith-/u, `${source} runs on ${label} instead of a Blacksmith runner`);
    return;
  }
  const workflow = YAML.parse(text);
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { branches: ['staging', 'agent-cli-verification-20260908', 'test/staging-e2e-cli-20260908'] });
  assert.ok(workflow.on.workflow_dispatch === null || Object.keys(workflow.on.workflow_dispatch).length === 0);
  assert.deepEqual(workflow.concurrency, { group: 'agent-cli-native-${{ github.ref }}', 'cancel-in-progress': false });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.env, undefined);
  assert.deepEqual(Object.keys(workflow.jobs), ['native']);
  const job = workflow.jobs.native;
  assert.equal(job.if, NATIVE_REF_GUARD, 'Native dispatch must never execute on main or another ref');
  assert.equal(job['runs-on'], '${{ matrix.os }}');
  assert.deepEqual(job.strategy, { 'fail-fast': false, matrix: { os: ['windows-2025', 'macos-15'] } });
  assert.equal(job['timeout-minutes'], 45);
  for (const key of ['permissions','environment','secrets','env','container','services','uses']) assert.equal(job[key], undefined);
  assert.ok(job.steps.length > 0 && job.steps.length <= 12);
  for (const step of job.steps) {
    assert.equal(step.env, undefined); assert.equal(step.secrets, undefined);
    if (step.run !== undefined) assert.ok(commands.has(step.run.trim()), `Unapproved native test command: ${step.run}`);
    else {
      assert.match(step.uses ?? '', /^(actions\/(checkout|setup-node|upload-artifact))@[a-f0-9]{40}$/);
      if (step.uses.startsWith('actions/checkout@')) {
        assert.equal(step.with?.['persist-credentials'], false);
        assert.equal(step.with?.ref, undefined); assert.equal(step.with?.repository, undefined);
      }
    }
  }
  assert.doesNotMatch(text, /\bsecrets\s*[.[]/i, 'Native test workflow cannot load publication/deployment secrets');
}
