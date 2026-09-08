// Native-platform, offline package proof. Linux callers must identify their Daytona sandbox.
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
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
const token = `rly_live_${'V'.repeat(43)}`;
const invalidToken = `rly_live_${'X'.repeat(43)}`;
const syntheticTokens = [token, invalidToken];
let tokenServer;
const env = { ...process.env, RELAY_CONFIG_PATH: join(scratch, 'config.json'), RELAY_API_URL: 'http://127.0.0.1:1', CI: 'true' };
for (const key of ['RELAY_AGENT_TOKEN', 'RELAY_PROFILE', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) delete env[key];
const report = { platform: platform(), arch: arch(), release: release(), node: process.version, sandbox: process.env.RELAY_DAYTONA_SANDBOX_ID ?? null, commands: [], coverage: 'native offline package/config proof; no live runtime claim' };
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024, ...options });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const item = { command: [command, ...args], exit: r.status, signal: r.signal, output: syntheticTokens.reduce((text, value) => text.replaceAll(value, '[SYNTHETIC TOKEN REDACTED]'), output), error: r.error?.message };
  report.commands.push(item);
  writeFileSync(join(receipts, 'receipt.json'), JSON.stringify(report, null, 2));
  assert.ok(syntheticTokens.every(value => !output.includes(value)), 'CLI leaked synthetic token');
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
  const shim = (args, options = {}) => npm(['exec', '--offline', '--', 'relaymessenger', ...args], { cwd: consumer, ...options });
  const help = cli('--help');
  assert.match(help, /^\s+auth[ \[]/m);
  assert.doesNotMatch(help, /^\s+(token|login|oauth|console)[ \[]/m);
  const hasAgentCommands = /^  agent(?:s)?[ \[]/m.test(help);
  assert.ok(hasAgentCommands, 'Canonical CLI must include agent commands');
  report.agentCommands = hasAgentCommands ? 'available; tests pending below' : 'pending feature commits: no agent command in root help';
  const expectedVersion = cliManifest.version;
  assert.equal(cli('--version').trim(), expectedVersion);
  for (const executable of Object.keys(cliManifest.bin)) {
    assert.equal(npm(['exec', '--offline', '--', executable, '--version'], { cwd: consumer }).trim(), expectedVersion);
  }
  const ready = join(scratch, 'token-server-ready.json');
  const httpLog = join(scratch, 'token-http.json');
  let serverError;
  tokenServer = spawn(process.execPath, [join(root, 'scripts/agent-cli-platforms-token-server.mjs'), ready, httpLog], { env, stdio: 'ignore' });
  tokenServer.on('error', error => { serverError = error; });
  const deadline = Date.now() + 10000;
  while (!existsSync(ready)) {
    if (serverError || tokenServer.exitCode !== null || Date.now() > deadline) throw Error('Native token HTTP fixture failed to start');
    await new Promise(done => setTimeout(done, 25));
  }
  env.RELAY_API_URL = JSON.parse(readFileSync(ready)).origin;
  cli('profiles', 'add', 'verification', '--api-url', env.RELAY_API_URL);
  cli('profiles', 'use', 'verification');
  shim(['auth', 'login', '--with-token'], { input: `${token}\n` });
  assert.equal(JSON.parse(shim(['auth', 'status'])).configured, true);
  assert.equal(JSON.parse(cli('profiles', 'list')).current_profile, 'verification');
  assert.equal(JSON.parse(readFileSync(env.RELAY_CONFIG_PATH)).profiles.verification.agent_token, token);
  const beforeInvalidImport = readFileSync(env.RELAY_CONFIG_PATH, 'utf8');
  shim(['auth', 'login', '--with-token'], { input: `${invalidToken}\n`, expectedExit: 1 });
  assert.equal(readFileSync(env.RELAY_CONFIG_PATH, 'utf8'), beforeInvalidImport, 'Invalid import must preserve the saved identity');
  shim(['auth', 'login'], { env: { ...env, RELAY_AGENT_TOKEN: token } });
  cli('doctor', '--offline');
  const envStatus = JSON.parse(shim(['auth', 'status'], { env: { ...env, RELAY_AGENT_TOKEN: token } }));
  assert.equal(envStatus.token_source, 'environment');
  shim(['auth', 'logout']);
  assert.equal(JSON.parse(readFileSync(env.RELAY_CONFIG_PATH)).profiles.verification.agent_token, undefined);
  run(process.execPath, [bin, 'auth', 'status'], { cwd: consumer, expectedExit: 1 });
  run(process.execPath, [bin, 'chats', 'list'], { cwd: consumer, expectedExit: 1 });
  cli('profiles', 'use', 'default');
  cli('profiles', 'remove', 'verification');
  shim(['token', 'status'], { expectedExit: 1 });
  assert.match(report.commands.at(-1).output, /unknown command/i, 'No token namespace is allowed');
  shim(['auth', 'login'], { expectedExit: 1, timeout: 5000 });
  assert.match(report.commands.at(-1).output, /non-interactive|--with-token/i);
  report.authProof = 'actual installed shim: stdin --with-token, invalid-token preservation, environment, status/logout, nonTTY no-flag failure; interactive PTY is separate';
  report.tokenHTTP = JSON.parse(readFileSync(httpLog));
  assert.ok(report.tokenHTTP.some(request => request.status === 200));
  assert.ok(report.tokenHTTP.some(request => request.status === 401));
  assert.ok(report.tokenHTTP.every(request => request.method === 'GET' && request.path === '/v1/contact_card'), 'Token import must never bootstrap');
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
    report.agentCommands = 'passed: native auth login --with-token/status/logout, agent help/list/missing-token, installed create/list/delete and existing-token native handoff fixture; live staging pending';
  }
  report.packageProof = 'passed';
  report.result = report.validationFailures.length ? 'failed' : 'passed';
  if (report.validationFailures.length) process.exitCode = 1;
} catch (error) {
  report.result = 'failed'; report.failure = error.message; process.exitCode = 1;
} finally {
  if (tokenServer && tokenServer.exitCode === null && tokenServer.signalCode === null) {
    const exited = new Promise(done => tokenServer.once('exit', done));
    tokenServer.kill();
    await Promise.race([exited, new Promise(done => setTimeout(done, 2000))]);
    if (tokenServer.exitCode === null && tokenServer.signalCode === null) tokenServer.kill('SIGKILL');
  }
  writeFileSync(join(receipts, 'receipt.json'), JSON.stringify(report, null, 2));
  rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ result: report.result, platform: report.platform, sha: report.sha, receipts }));
}
