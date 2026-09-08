import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const scripts = [];
for (const file of ["publish-package-staging.yml", "staging-package.yml", "ci.yml"]) {
  const workflow = YAML.parse(readFileSync(
    new URL(`../.github/workflows/${file}`, import.meta.url), "utf8",
  ));
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") continue;
      scripts.push({
        name: `${file}:${jobName}:${step.name ?? step.run.split("\n")[0]}`,
        script: step.run.replace(/\$\{\{[\s\S]*?\}\}/gu, "github-expression"),
      });
    }
  }
}
function parse(script) {
  return spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
}
for (const { name, script } of scripts) {
  test(`Bash syntax: ${name}`, () => {
    const result = parse(script);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });
}
test("the malformed bump guard is caught before any publish or Git mutation", () => {
  const step = scripts.find(({ name }) => name.endsWith(":Commit the bump to staging"));
  assert.ok(step);
  const broken = step.script.replace(/\nthen\n/u, " \\\nthen\n");
  assert.notEqual(broken, step.script);
  assert.notEqual(parse(broken).status, 0);
});
