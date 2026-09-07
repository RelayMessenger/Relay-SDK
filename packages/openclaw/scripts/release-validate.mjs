import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  resolve,
} from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const commands = [
  ["run", "validate"],
  ["run", "pack:smoke"],
  ["run", "gateway:harness"],
];
const receiptPath = process.env.RELAY_VALIDATION_RECEIPT;
const logDirectory = process.env.RELAY_VALIDATION_LOG_DIR;
const results = [];

function redact(value) {
  const output = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .replace(/\b(?:npm|ghp|github_pat)_[A-Za-z0-9_=-]{8,}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\brly_[A-Za-z0-9_-]+\b/gu, "rly_[REDACTED]");
  const redactions = output === value
    ? 0
    : value.split("\n").filter((line, index) =>
      line !== output.split("\n")[index]).length;
  return { output, redactions };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function retainReceipt(overallExitCode) {
  const receipt = {
    schema: "relay-openclaw-release-validation/v1",
    commands: results,
    overallExitCode,
  };
  if (receiptPath) {
    mkdirSync(dirname(resolve(receiptPath)), { recursive: true });
    writeFileSync(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }
  return receipt;
}

for (const [index, args] of commands.entries()) {
  const command = `${npm} ${args.join(" ")}`;
  console.log(`::relay-validation-command::${JSON.stringify({ command })}`);
  const run = spawnSync(npm, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const stdout = redact(run.stdout ?? "");
  const stderr = redact(run.stderr ?? "");
  process.stdout.write(stdout.output);
  process.stderr.write(stderr.output);
  const combined = [
    `$ ${command}`,
    stdout.output,
    stderr.output,
  ].join("\n");
  const logName = `${index + 1}-${args[1].replaceAll(":", "-")}.log`;
  if (logDirectory) {
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(resolve(logDirectory, logName), combined);
  }
  const exitCode = run.status ?? 1;
  const result = {
    command,
    exitCode,
    log: {
      file: logDirectory ? basename(resolve(logDirectory, logName)) : null,
      sha256: sha256(combined),
      bytes: Buffer.byteLength(combined),
      redactions: stdout.redactions + stderr.redactions,
    },
  };
  results.push(result);
  console.log(`::relay-validation-result::${JSON.stringify(result)}`);
  if (exitCode !== 0) {
    retainReceipt(exitCode);
    process.exit(exitCode);
  }
}

const receipt = retainReceipt(0);
console.log(`::relay-validation-receipt::${JSON.stringify(receipt)}`);
