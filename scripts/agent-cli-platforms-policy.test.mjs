import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { NATIVE_WORKFLOW, validateRunnerPolicy } from './agent-cli-platforms-policy.mjs';
import { negativePolicyFixtures, verifyPolicyFixtures } from './agent-cli-platforms-policy-fixtures.mjs';
const text = readFileSync(new URL('../.github/workflows/agent-cli-platforms.yml', import.meta.url),'utf8');
test('only the exact native workflow gets its bounded exception', () => verifyPolicyFixtures(text));
for (const [label, mutate] of negativePolicyFixtures) test(`reject ${label}`, () => {
  const value = YAML.parse(text); mutate(value);
  assert.throws(() => validateRunnerPolicy(NATIVE_WORKFLOW, YAML.stringify(value)));
});
