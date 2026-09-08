// Native-platform, offline package proof. Linux callers must identify their Daytona sandbox.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir, platform, arch, release } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (platform() === 'linux' && !process.env.RELAY_DAYTONA_SANDBOX_ID) throw Error('Linux proof requires an owned Daytona sandbox ID.');
const receipts = resolve(process.env.RELAY_PLATFORM_RECEIPTS ?? join(root, '.release-tmp', 'agent-cli-platforms', `${platform()}-${arch()}`));
mkdirSync(receipts, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'relay-platform-'));
const token = 'synthetic-offline-platform-token-not-a-credential';
const env = { ...process.env, RELAY_CONFIG_PATH: join(scratch, 'config.json'), RELAY_API_URL: 'http://127.0.0.1:1', CI: 'true' };
for (const key of ['RELAY_AGENT_TOKEN', 'RELAY_PROFILE', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) delete env[key];
const report = { platform: platform(), arch: arch(), release: release(), node: process.version, sandbox: process.env.RELAY_DAYTONA_SANDBOX_ID ?? null, commands: [], coverage: 'native offline package/config proof; no live runtime claim' };
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024, ...options });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const item = { command: [command, ...args], exit: r.status, signal: r.signal, output: output.replaceAll(token, '[SYNTHETIC TOKEN REDACTED]'), error: r.error?.message };
  report.commands.push(item);
  writeFileSync(join(receipts, 'receipt.json'), JSON.stringify(report, null, 2));
  assert.ok(!output.includes(token), 'CLI leaked synthetic token');
  assert.equal(r.status, options.expectedExit ?? 0, JSON.stringify(item));
  return r.stdout ?? '';
}
// Invoking npm's JS entry point avoids Windows .cmd spawn limitations.
const npmLocation = spawnSync(platform() === 'win32' ? 'where.exe' : 'which', ['npm'], { encoding: 'utf8' });
assert.equal(npmLocation.status, 0, 'npm must already be installed');
const npmBinary = npmLocation.stdout.trim().split(/\r?\n/)[0];
const npmCli = process.env.npm_execpath ?? (platform() === 'win32'
  ? join(dirname(npmBinary), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : realpathSync(npmBinary));
const npm = (args, options) => run(process.execPath, [npmCli, ...args], options);
try {
  report.sha = run('git', ['rev-parse', 'HEAD']).trim();
  report.dirty = run('git', ['status', '--porcelain']).trim();
  const packageNames = { sdk: '@relaymessenger/sdk', cli: 'relaymessenger' };
  const cliManifest = JSON.parse(readFileSync(join(root, 'packages/cli/package.json')));
  assert.equal(cliManifest.name, packageNames.cli, 'Final proof requires canonical relaymessenger, not a scoped wrapper');
  assert.ok(cliManifest.bin?.relaymessenger, 'Canonical executable missing');
  report.packageName = cliManifest.name;
  report.packageVersion = cliManifest.version;
  report.validationFailures = [];
  for (const pkg of ['sdk', 'cli']) {
    for (const task of ['check', 'build']) npm(['run', task, '--workspace', packageNames[pkg]]);
    // Keep the overall run red, but still collect independent installed-package evidence.
    try { npm(['run', 'test', '--workspace', packageNames[pkg]]); }
    catch (error) { report.validationFailures.push({ package: pkg, failure: error.message }); }
  }
  const packs = {};
  for (const pkg of ['sdk', 'cli']) {
    const packed = JSON.parse(npm(['pack', '--workspace', packageNames[pkg], '--ignore-scripts', '--json', '--pack-destination', scratch]));
    packs[pkg] = join(scratch, packed[0].filename);
  }
  report.tarballSHA256 = Object.fromEntries(Object.entries(packs).map(([k,v]) => [k,createHash('sha256').update(readFileSync(v)).digest('hex')]));
  const consumer = join(scratch, 'consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', packs.sdk, packs.cli], { cwd: consumer });
  assert.ok(!existsSync(join(consumer, 'node_modules', '@relaymessenger', 'cli')), 'Retired scoped compatibility package must not be installed');
  const bin = resolve(consumer, 'node_modules', packageNames.cli, cliManifest.bin.relaymessenger);
  const cli = (...args) => run(process.execPath, [bin, ...args], { cwd: consumer });
  const help = cli('--help');
  assert.match(help, /auth/);
  const hasAgentCommands = /^  agent(?:s)?[ \[]/m.test(help);
  report.agentCommands = hasAgentCommands ? 'available; tests pending below' : 'pending feature commits: no agent command in root help';
  const expectedVersion = cliManifest.version;
  assert.equal(cli('--version').trim(), expectedVersion);
  for (const executable of Object.keys(cliManifest.bin)) {
    assert.equal(npm(['exec', '--offline', '--', executable, '--version'], { cwd: consumer }).trim(), expectedVersion);
  }
  cli('profiles', 'add', 'verification', '--api-url', 'http://127.0.0.1:1');
  cli('profiles', 'use', 'verification');
  run(process.execPath, [bin, 'auth', 'login', '--token-stdin'], { cwd: consumer, input: `${token}\n` });
  assert.equal(JSON.parse(cli('auth', 'status')).authenticated, true);
  assert.equal(JSON.parse(cli('profiles', 'list')).current_profile, 'verification');
  assert.equal(JSON.parse(readFileSync(env.RELAY_CONFIG_PATH)).profiles.verification.agent_token, token);
  cli('doctor', '--offline');
  const envStatus = JSON.parse(run(process.execPath, [bin, 'auth', 'status'], { cwd: consumer, env: { ...env, RELAY_AGENT_TOKEN: token } }));
  assert.equal(envStatus.token_source, 'environment');
  cli('auth', 'logout');
  assert.equal(JSON.parse(readFileSync(env.RELAY_CONFIG_PATH)).profiles.verification.agent_token, undefined);
  run(process.execPath, [bin, 'auth', 'status'], { cwd: consumer, expectedExit: 1 });
  run(process.execPath, [bin, 'chats', 'list'], { cwd: consumer, expectedExit: 1 });
  cli('profiles', 'use', 'default');
  cli('profiles', 'remove', 'verification');
  if (hasAgentCommands) {
    const agentHelp = cli('agents', '--help');
    assert.match(agentHelp, /create/);
    assert.doesNotMatch(agentHelp, /^\s+setup[ \[]/m, 'Owner approved exactly create/list/delete under agents');
    assert.match(cli('agents', 'create', '--help'), /token-name/);
    assert.match(cli('agents', 'delete', '--help'), /handle/);
    const inventory = JSON.parse(cli('agents', 'list', '--json'));
    assert.ok(inventory.agents.every(item => item.token === 'missing'));
    run(process.execPath, [bin, 'agents', 'delete', 'verification_bird.dev'], { cwd: consumer, expectedExit: 1 });
    // The core-owned consumer exercises the installed module with an injected HTTP fixture.
    // Native process checks above and module fixture checks are recorded separately from live staging.
    run(process.execPath, [join(root, 'packages/cli/scripts/agent-tarball-consumer.mjs'), consumer, scratch], { cwd: consumer });
    report.agentCommands = 'passed: native help/list/missing-auth plus installed create/list/delete HTTP-fixture lifecycle; live staging pending';
  }
  report.packageProof = 'passed';
  report.result = report.validationFailures.length ? 'failed' : 'passed';
  if (report.validationFailures.length) process.exitCode = 1;
} catch (error) {
  report.result = 'failed'; report.failure = error.message; process.exitCode = 1;
} finally {
  writeFileSync(join(receipts, 'receipt.json'), JSON.stringify(report, null, 2));
  rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ result: report.result, platform: report.platform, sha: report.sha, receipts }));
}
