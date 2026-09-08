import { inspectWindowsAcl, privateWindowsAcl, protectWindowsPath } from "../src/runtime-connect/windows-acl.js";
import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { applyRuntimeConnect, planRuntimeConnect } from '../src/runtime-connect.js';
import type { RuntimeConnectInput } from '../src/runtime-connect.js';

const roots: string[] = [];
const token = 'rly_private_test_only_not_real';
const origin = 'https://api.staging.relayapp.im';
const agent = { token, origin, handle: 'test_bird.dev' };
const consent = { consent: true, runtimeStopped: true } as const;
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), 'relay-handoff-'))); roots.push(path); if (process.platform === "win32") await protectWindowsPath(path, true); return path; }
async function privateFile(path: string, text: string) { await writeFile(path, text, { mode: 0o600 }); if (process.platform === "win32") await protectWindowsPath(path); }
async function claw(config: unknown = { channels: { relay: { accounts: { work: { allowFrom: ['alice'] }, other: { token: 'other-token', allowFrom: ['bob'] } } } }, unrelated: { x: 42 } }) {
  const home = await root(); const path = join(home, 'openclaw.json'); await privateFile(path, JSON.stringify(config, null, 2) + '\n');
  const input: RuntimeConnectInput = { agent: { ...agent }, target: { runtime: 'openclaw', configPath: path, stateDir: home, account: 'work', profile: 'my-profile' } };
  return { home, path, input };
}
async function claude(env = 'RELAY_ALLOWED_SENDERS=alice\n') {
  const home = await root(); const path = join(home, '.env'); await privateFile(path, env);
  const input: RuntimeConnectInput = { agent: { ...agent }, target: { runtime: 'claude-code', channelDir: home, context: 'session-a' } };
  return { home, path, input };
}
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('optional runtime handoff', { timeout: 120_000 }, () => {
  it('roundtrips JSON, preserves other accounts and permissions, and restores exact bytes', async () => {
    const { path, input } = await claw(); const original = await readFile(path);
    const originalAcl = process.platform === "win32" ? (await inspectWindowsAcl(path)).sddl : undefined;
    const plan = await planRuntimeConnect(input); expect(plan.status).toBe('ready'); expect(await readFile(path)).toEqual(original);
    const applied = await applyRuntimeConnect(plan, consent); expect(applied.status).toBe('configured');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.channels.relay.accounts.work).toEqual({ token, baseUrl: origin, allowFrom: ['alice'] });
    expect(parsed.channels.relay.accounts.other).toEqual({ token: 'other-token', allowFrom: ['bob'] }); expect(parsed.unrelated).toEqual({ x: 42 });
    if (process.platform === "win32") { const acl = await inspectWindowsAcl(path); expect(privateWindowsAcl(acl)).toBe(true); expect(acl.sddl).toBe(originalAcl); }
    else expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await applied.rollback!(consent)).code).toBe('rolled-back'); expect(await readFile(path)).toEqual(original);
    if (process.platform === 'win32') expect((await inspectWindowsAcl(path)).sddl).toBe(originalAcl);
  });
  it('is byte-idempotent and keeps plans one-shot', async () => {
    const { path, input } = await claw(); await applyRuntimeConnect(await planRuntimeConnect(input), consent);
    const bytes = await readFile(path); const stat = await lstat(path); const plan = await planRuntimeConnect(input);
    expect((await applyRuntimeConnect(plan, consent)).status).toBe('configured'); expect(await readFile(path)).toEqual(bytes); expect((await lstat(path)).ino).toBe(stat.ino);
    expect((await applyRuntimeConnect(plan, consent)).code).toBe('plan-required');
  });
  it('never overwrites an existing identity', async () => {
    const { path, input } = await claw({ channels: { relay: { accounts: { work: { token: 'old-token', baseUrl: origin } } } } });
    const before = await readFile(path); expect((await planRuntimeConnect(input)).code).toBe('identity-change'); expect(await readFile(path)).toEqual(before);
  });
  it('never replaces shared tokenFile config', async () => {
    const { input } = await claw({ channels: { relay: { accounts: { work: { tokenFile: '/not-read' } } } } });
    expect((await planRuntimeConnect(input)).code).toBe('credential-reference');
  });
  it('does not confuse a profile, brain, and account', async () => {
    const { input } = await claw(); if (input.target.runtime !== 'openclaw') throw Error();
    input.target.brain = 'brain-a'; expect((await planRuntimeConnect(input)).code).toBe('brain-binding-required');
    input.target.account = 'missing'; expect((await planRuntimeConnect(input)).code).toBe('brain-binding-required');
  });
  it('accepts an existing exact brain binding without rewriting it', async () => {
    const bindings = [{ agentId: 'brain-a', match: { channel: 'relay', accountId: 'work' } }];
    const { path, input } = await claw({ channels: { relay: { accounts: { work: {} } } }, bindings });
    if (input.target.runtime !== 'openclaw') throw Error(); input.target.brain = 'brain-a';
    expect((await applyRuntimeConnect(await planRuntimeConnect(input), consent)).status).toBe('configured');
    expect(JSON.parse(await readFile(path, 'utf8')).bindings).toEqual(bindings);
  });
  it('requires Claude senders without inferring an owner or writing a token', async () => {
    const { path, input } = await claude('# no grants\nOTHER=x\n'); const before = await readFile(path);
    expect((await planRuntimeConnect(input)).code).toBe('allowed-senders-required'); expect(await readFile(path)).toEqual(before);
  });
  it('requires real sender permissions rather than an unresolved plugin placeholder', async () => {
    const { input } = await claude('RELAY_ALLOWED_SENDERS=${user_config.allowed_senders}\n');
    expect((await planRuntimeConnect(input)).code).toBe('allowed-senders-required');
  });
  it('preserves env comments, exports, unrelated values, CRLF, and sender permissions', async () => {
    const text = '# keep\r\nexport OTHER="hello world"\r\nRELAY_ALLOWED_SENDERS=alice,bob\r\n';
    const { path, input } = await claude(text); const result = await applyRuntimeConnect(await planRuntimeConnect(input), consent);
    expect(result.status).toBe('configured'); const configured = await readFile(path, 'utf8');
    expect(configured.startsWith(text)).toBe(true); expect(configured).toContain(`RELAY_AGENT_TOKEN="${token}"\r\n`);
    expect(configured).toContain('RELAY_CHANNEL_SESSION_ID="session-a"');
    await applyRuntimeConnect(await planRuntimeConnect(input), consent); expect(await readFile(path, 'utf8')).toBe(configured);
    expect((await result.rollback!(consent)).code).toBe('rolled-back'); expect(await readFile(path, 'utf8')).toBe(text);
  });
  it('keeps different Claude sessions in separate directories', async () => {
    const a = await claude(); const b = await claude(); b.input.agent = { ...agent, token: 'another-private-token' };
    if (b.input.target.runtime !== 'claude-code') throw Error(); b.input.target.context = 'session-b';
    await applyRuntimeConnect(await planRuntimeConnect(a.input), consent); const bytes = await readFile(a.path);
    await applyRuntimeConnect(await planRuntimeConnect(b.input), consent); expect(await readFile(a.path)).toEqual(bytes);
    expect(await readFile(b.path, 'utf8')).toContain('another-private-token');
  });
  it('refuses the global Claude channel file', async () => {
    const home = await root(); const input: RuntimeConnectInput = { agent: { ...agent }, target: { runtime: 'claude-code', claudeConfigDir: home, channelDir: join(home, 'channels', 'relay'), context: 'a' } };
    expect((await planRuntimeConnect(input)).code).toBe('session-scope-required');
  });
  it('refuses another existing session context', async () => {
    const { input } = await claude('RELAY_ALLOWED_SENDERS=alice\nRELAY_CHANNEL_SESSION_ID=someone-else\n');
    expect((await planRuntimeConnect(input)).code).toBe('context-conflict');
  });
  it('fails closed on duplicate or complex env syntax', async () => {
    const { input } = await claude('RELAY_ALLOWED_SENDERS=alice\nRELAY_ALLOWED_SENDERS=bob\n'); expect((await planRuntimeConnect(input)).code).toBe('duplicate-env');
  });
  it('does not serialize tokens in plans, results, inspection, or malformed-config errors', async () => {
    const { path, input } = await claw(); const plan = await planRuntimeConnect(input); const result = await applyRuntimeConnect(plan, consent);
    for (const view of [JSON.stringify(plan), inspect(plan, { showHidden: true }), JSON.stringify(result), inspect(result, { showHidden: true })]) expect(view).not.toContain(token);
    await privateFile(path, `{ "${token}": broken }`); const bad = await planRuntimeConnect(input); expect(JSON.stringify(bad)).not.toContain(token); expect(bad.status).toBe('required-action');
    input.agent.origin = `https://${token}@example.com`; expect(JSON.stringify(await planRuntimeConnect(input))).not.toContain(token);
  });
  it('requires explicit consent and a stopped selected runtime', async () => {
    const { input } = await claw(); const plan = await planRuntimeConnect(input);
    expect((await applyRuntimeConnect(plan, { consent: false } as never)).code).toBe('consent-required');
    expect((await applyRuntimeConnect(plan, { consent: true } as never)).code).toBe('consent-required');
  });
  it('does not overwrite edits made after planning or after applying', async () => {
    const { path, input } = await claw(); const plan = await planRuntimeConnect(input); await privateFile(path, '{"edited":true}');
    expect((await applyRuntimeConnect(plan, consent)).status).toBe('conflict'); expect(await readFile(path, 'utf8')).toBe('{"edited":true}');
    const next = await claw(); const result = await applyRuntimeConnect(await planRuntimeConnect(next.input), consent); await privateFile(next.path, '{"after":true}');
    expect((await result.rollback!(consent)).status).toBe('conflict'); expect(await readFile(next.path, 'utf8')).toBe('{"after":true}');
  });
  it('rejects public files and symlink targets', async () => {
    const { path, input, home } = await claw();
    if (process.platform !== 'win32') { await chmod(path, 0o644); expect((await planRuntimeConnect(input)).code).toBe('private-file-required'); await chmod(path, 0o600); }
    const linked = join(home, 'linked.json'); await symlink(path, linked);
    if (input.target.runtime !== 'openclaw') throw Error(); input.target.configPath = linked; expect((await planRuntimeConnect(input)).code).toBe('unsafe-file');
  });
  it('does not silently re-enable a disabled channel', async () => {
    const { input } = await claw({ channels: { relay: { enabled: false, accounts: { work: {} } } } }); expect((await planRuntimeConnect(input)).code).toBe('channel-disabled');
  });
  it('rejects inherited property selectors', async () => {
    const { input } = await claw(); if (input.target.runtime !== 'openclaw') throw Error(); input.target.account = 'constructor';
    expect((await planRuntimeConnect(input)).code).toBe('account-missing');
  });
  it('requires explicit native paths rather than guessing Windows paths on Unix', async () => {
    expect(win32.join('C:\\Users\\me', '.hermes', '.env')).toBe('C:\\Users\\me\\.hermes\\.env');
    expect(posix.join('/Users/me', '.hermes', '.env')).toBe('/Users/me/.hermes/.env');
    const { input } = await claw(); if (input.target.runtime !== 'openclaw') throw Error(); input.target.configPath = 'relative/openclaw.json';
    expect((await planRuntimeConnect(input)).code).toBe('absolute-path-required');
    if (process.platform !== 'win32') { input.target.configPath = 'C:\\Users\\me\\openclaw.json'; expect((await planRuntimeConnect(input)).code).toBe('absolute-path-required'); }
  });
  it('rejects invalid credentials without creation fallback', async () => {
    const { input } = await claw(); for (const invalid of ['', 'bad\nvalue', 'bad value']) { input.agent = { ...agent, token: invalid }; expect((await planRuntimeConnect(input)).code).toBe('invalid-token'); }
  });

  it('serializes competing handoffs without overwriting either slot decision', async () => {
    const { input } = await claw(); const other = { ...input, agent: { ...agent, token: 'different-private-token' } };
    const a = await planRuntimeConnect(input); const b = await planRuntimeConnect(other);
    const results = await Promise.all([applyRuntimeConnect(a, consent), applyRuntimeConnect(b, consent)]);
    expect(results.filter(r => r.status === 'configured')).toHaveLength(1);
    expect(results.filter(r => r.status === 'conflict')).toHaveLength(1);
  });
  it('rejects duplicate credentials in different OpenClaw slots', async () => {
    const { input } = await claw({ channels: { relay: { accounts: { work: {}, other: { token } } } } });
    expect((await planRuntimeConnect(input)).code).toBe('credential-in-use');
  });
  it('does not guess an implicit OpenClaw environment credential', async () => {
    const { input } = await claw({ channels: { relay: {} } });
    if (input.target.runtime !== 'openclaw') throw Error(); input.target.account = 'default';
    const previous = process.env.RELAY_AGENT_TOKEN;
    try { process.env.RELAY_AGENT_TOKEN = 'occupied-other-token'; expect((await planRuntimeConnect(input)).code).toBe('default-scope-required'); }
    finally { if (previous === undefined) delete process.env.RELAY_AGENT_TOKEN; else process.env.RELAY_AGENT_TOKEN = previous; }
  });
  it('rechecks state that appeared after planning', async () => {
    const { input, home, path } = await claw(); const plan = await planRuntimeConnect(input); const bytes = await readFile(path);
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    await mkdir(join(home, 'relay'), { mode: 0o700 });
    const name = `account-${hash(`transport-${hash(`${origin}\0${token}`)}`).slice(0, 24)}.sqlite`;
    await privateFile(join(home, 'relay', name), 'durable-state');
    expect((await applyRuntimeConnect(plan, consent)).code).toBe('durable-state-present'); expect(await readFile(path)).toEqual(bytes);
  });
  it('checks Windows ACL permissions rather than assuming POSIX modes', () => {
    const acl = { user: 'S-1-5-21-test', owner: 'S-1-5-21-test', sddl: 'test-descriptor', rules: [{ sid: 'S-1-5-21-test', rights: 2032127, type: 'Allow' }] };
    expect(privateWindowsAcl(acl)).toBe(true);
    expect(privateWindowsAcl({ ...acl, rules: [...acl.rules, { sid: 'S-1-1-0', rights: 1, type: 'Allow' }] })).toBe(false);
    expect(privateWindowsAcl({ ...acl, rules: [...acl.rules, { sid: 'S-1-1-0', rights: 2, type: 'Allow' }] }, true)).toBe(false);
  });
  it('requires Hermes profile resolution rather than guessing YAML or another profile secret', async () => {
    const home = await root(); await privateFile(join(home, 'config.yaml'), 'platforms: {}\n'); await privateFile(join(home, '.env'), 'OTHER=keep\n');
    expect((await planRuntimeConnect({ agent: { ...agent }, target: { runtime: 'hermes', profileHome: home } })).code).toBe('state-path-required');
  });
  it('checks both Hermes sidecar and durable SQLite binding without changing either', async () => {
    const home = await root(); await privateFile(join(home, 'config.yaml'), 'platforms: {}\n'); await privateFile(join(home, '.env'), `RELAY_AGENT_TOKEN=${token}\nRELAY_BASE_URL=${origin}\nRELAY_ALLOWED_CONTACTS=alice\nRELAY_STATE_DIR=${join(home, 'relay')}\n`);
    const state = join(home, 'relay'); await mkdir(state, { mode: 0o700 });
    const hash = (value: string) => createHash('sha256').update(value).digest('hex'); const fp = `sha256:${hash(`relay-hermes-token-v1\0${token}`)}`;
    const account = `sha256:${hash(`relay-hermes-account-v1\0${JSON.stringify({ api_origin: origin, token_fingerprint: fp })}`)}`;
    const binding = { schema: 'relay-hermes-state-account/v1', api_origin: origin, token_fingerprint: fp, account_fingerprint: account };
    await privateFile(join(state, '.relay-account.json'), JSON.stringify(binding));
    const { DatabaseSync } = await import('node:sqlite'); const path = join(state, 'inbox.sqlite3'); const db = new DatabaseSync(path);
    db.exec('CREATE TABLE relay_state_account(singleton INTEGER PRIMARY KEY, binding_schema TEXT, api_origin TEXT, token_fingerprint TEXT, account_fingerprint TEXT)');
    db.prepare('INSERT INTO relay_state_account VALUES (1, ?, ?, ?, ?)').run(binding.schema, origin, fp, account); db.close(); await chmod(path, 0o600);
    const bytes = await readFile(path); const input: RuntimeConnectInput = { agent: { ...agent }, target: { runtime: 'hermes', profileHome: home } };
    expect((await planRuntimeConnect(input)).status).toBe('ready'); expect(await readFile(path)).toEqual(bytes);
    const corrupt = new DatabaseSync(path); corrupt.exec("UPDATE relay_state_account SET api_origin = 'https://wrong.example'"); corrupt.close();
    expect((await planRuntimeConnect(input)).code).toBe('state-binding-mismatch');
  });
});

describe('native initial binding', { timeout: 120_000 }, () => {
it('initializes an empty Hermes profile, preserves YAML/permissions, and rolls back', async () => {
  const home = await root();
  const yaml = 'gateway:\n  platforms:\n    relayapp:\n      enabled: true\n      extra:\n        allowed_contacts: [alice]\n';
  await privateFile(join(home, 'config.yaml'), yaml);
  await privateFile(join(home, '.env'), 'OTHER=keep\n');
  const input: RuntimeConnectInput = { agent, target: { runtime: 'hermes', profileHome: home, stateDir: home } };
  const plan = await planRuntimeConnect(input);
  expect(plan.status).toBe('ready');
  const applied = await applyRuntimeConnect(plan, consent);
  expect(applied.status).toBe('configured');
  const saved = await readFile(join(home, '.env'), 'utf8');
  expect(saved).toContain(`RELAY_AGENT_TOKEN="${token}"`);
  expect(saved).toContain('OTHER=keep');
  expect(await readFile(join(home, 'config.yaml'), 'utf8')).toBe(yaml);
  expect((await applied.rollback!(consent)).code).toBe('rolled-back');
  expect(await readFile(join(home, '.env'), 'utf8')).toBe('OTHER=keep\n');
});

it('never initializes an empty Hermes profile over occupied YAML credentials or state', async () => {
  const home = await root();
  const yaml = join(home, 'config.yaml');
  await privateFile(yaml, 'gateway:\n  platforms:\n    relayapp:\n      extra:\n        token: occupied-secret\n');
  const input: RuntimeConnectInput = { agent, target: { runtime: 'hermes', profileHome: home, stateDir: home } };
  expect((await planRuntimeConnect(input)).code).toBe('identity-change');
  await privateFile(yaml, 'gateway: {}\n');
  await privateFile(join(home, 'inbox.sqlite3'), 'corrupt database');
  expect((await planRuntimeConnect(input)).code).toBe('durable-state-present');
});

it('initializes an explicit new OpenClaw account without altering existing policy or accounts', async () => {
  const { input, path } = await claw();
  if (input.target.runtime !== 'openclaw') throw Error();
  input.target.account = 'new-account';
  const before = JSON.parse(await readFile(path, 'utf8'));
  const applied = await applyRuntimeConnect(await planRuntimeConnect(input), consent);
  expect(applied.status).toBe('configured');
  const after = JSON.parse(await readFile(path, 'utf8'));
  expect(after.channels.relay.accounts.work).toEqual(before.channels.relay.accounts.work);
  expect(after.channels.relay.accounts.other).toEqual(before.channels.relay.accounts.other);
  expect(after.channels.relay.accounts['new-account']).toEqual({ token, baseUrl: origin });
});

it('initializes a known empty default OpenClaw context without an occupied environment', async () => {
  const { input, path } = await claw({ channels: { relay: { allowFrom: ['alice'] } } });
  if (input.target.runtime !== 'openclaw') throw Error(); input.target.account = 'default';
  const previous = process.env.RELAY_AGENT_TOKEN;
  try {
    delete process.env.RELAY_AGENT_TOKEN;
    const result = await applyRuntimeConnect(await planRuntimeConnect(input), consent);
    expect(result.status).toBe('configured');
    expect(JSON.parse(await readFile(path, 'utf8')).channels.relay).toEqual({ allowFrom: ['alice'], token, baseUrl: origin });
  } finally { if (previous !== undefined) process.env.RELAY_AGENT_TOKEN = previous; }
});

});
