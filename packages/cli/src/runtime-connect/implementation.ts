import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeConnectConsent, RuntimeConnectInput, RuntimeConnectPlan, RuntimeConnectResult } from '../runtime-connect.js';

type Json = Record<string, unknown>;
type Snapshot = { path: string; bytes: Buffer | null; mode: number; ino: number; dev: number };
type PrivatePlan = { before: Snapshot; after: Buffer; guards: Snapshot[]; validateState: () => Promise<void>; applied: boolean };
const plans = new WeakMap<RuntimeConnectPlan, PrivatePlan>();
class Action extends Error { constructor(readonly code: string, message: string, readonly conflict = false) { super(message); } }
function fail(code: string, message: string, conflict = false): never { throw new Action(code, message, conflict); }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-config', 'Expected an existing JSON object; repair configuration explicitly.');
  return value as Json;
};
const own = (value: Json, key: string) => Object.hasOwn(value, key) ? value[key] : undefined;
function origin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    fail('invalid-origin', 'Use an HTTPS API origin, or loopback HTTP for tests.');
  }
  return url.origin;
}
async function safeParents(path: string): Promise<void> {
  if (!isAbsolute(path)) fail('absolute-path-required', 'Resolve runtime paths explicitly before handoff.');
  const parent = await fs.lstat(dirname(path));
  if (process.platform !== 'win32' && ((parent.mode & 0o022) !== 0 || parent.uid !== process.getuid?.())) fail('unsafe-directory', 'The selected configuration directory must be owned by this user and not writable by others.');
  for (let current = dirname(path); ; current = dirname(current)) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-path', 'Runtime configuration must not traverse symbolic links.');
    if (dirname(current) === current) break;
  }
}
async function snapshot(path: string, optional = false): Promise<Snapshot> {
  await safeParents(path);
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe-file', 'Use a regular, unlinked runtime configuration file.');
    // Do not widen, silently tighten, or copy shared secret permissions.
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      fail('private-file-required', 'Make the selected configuration owner-private before storing credentials.');
    }
    const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) fail('changed', 'Configuration changed; plan again.', true);
      return { path, bytes: await file.readFile(), mode: stat.mode & 0o777, ino: stat.ino, dev: stat.dev };
    } finally { await file.close(); }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return { path, bytes: null, mode: 0o600, ino: 0, dev: 0 };
    throw error;
  }
}
async function unchanged(before: Snapshot): Promise<boolean> {
  const now = await snapshot(before.path, true);
  return now.mode === before.mode && now.ino === before.ino && now.dev === before.dev &&
    (now.bytes === null ? before.bytes === null : before.bytes !== null && now.bytes.equals(before.bytes));
}
function envFile(text: string): { values: Record<string, string>; update: (changes: Record<string, string>) => string } {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const lines = text.split(/\r?\n/u);
  const indices = new Map<string, number>();
  lines.forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) fail('complex-env', 'Simplify unsupported environment syntax before handoff.');
    const key = match[1];
    if (indices.has(key)) fail('duplicate-env', 'Remove duplicate environment keys before handoff.');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else if (/\s#/u.test(value)) fail('complex-env', 'Move inline environment comments to separate lines before handoff.');
    if (/[\r\n\u0000]/u.test(value)) fail('complex-env', 'Repair environment configuration before handoff.');
    values[key] = value;
    indices.set(key, index);
  });
  return { values, update(changes) {
    const output = [...lines];
    for (const [key, value] of Object.entries(changes)) {
      if (values[key] === value) continue;
      if (/[\r\n\u0000"'`$\\]/u.test(value)) fail('unsafe-env-value', 'Selected value cannot be represented safely in this runtime environment file.');
      const line = `${key}="${value}"`;
      const index = indices.get(key);
      if (index !== undefined) output[index] = line;
      else { if (output.at(-1) === '') output.pop(); output.push(line, ''); }
    }
    return output.join(text.includes('\r\n') ? '\r\n' : '\n');
  } };
}
function keepIdentity(oldToken: unknown, oldOrigin: unknown, token: string, base: string): void {
  if (oldToken !== undefined && typeof oldToken !== 'string') fail('credential-reference', 'Resolve the existing secret reference with the runtime before handoff.');
  if (typeof oldToken === 'string' && oldToken.trim() &&
    (oldToken.trim() !== token || origin(typeof oldOrigin === 'string' ? oldOrigin : 'https://api.relayapp.im') !== base)) {
    fail('identity-change', 'This slot already has a different credential or origin. Choose another slot or explicitly migrate its durable state outside this helper.', true);
  }
}
function result(error: unknown): RuntimeConnectResult {
  return error instanceof Action
    ? { status: error.conflict ? 'conflict' : 'required-action', code: error.code, message: error.message }
    : { status: 'required-action', code: 'inspection-failed', message: 'Could not safely inspect or update the selected runtime. Check paths, configuration syntax, installation, and private permissions; then plan again.' };
}
async function absentState(path: string, guards: Snapshot[]): Promise<void> {
  const state = await snapshot(path, true);
  guards.push(state);
  if (state.bytes !== null) fail('durable-state-present', 'Existing durable state needs runtime-native verification before changing credentials; no state was modified.', true);
}

export async function planRuntimeConnect(input: RuntimeConnectInput): Promise<RuntimeConnectPlan> {
  try {
    if (process.platform === 'win32') fail('windows-acl-verification-required', 'Windows credential writes need native ACL-preservation verification; use the runtime private-secret workflow until that proof is integrated.');
    const token = input.agent.token;
    if (!token || token !== token.trim() || token.length > 4096 || /[\u0000-\u0020\u007f]/u.test(token)) fail('invalid-token', 'Provide a resolved, valid Agent Token through a private input. Invalid credentials never create an agent.');
    const base = origin(input.agent.origin);
    const target = input.target;
    const guards: Snapshot[] = [];
    let validateState: () => Promise<void> = async () => undefined;
    let before: Snapshot;
    let after: string;
    if (target.runtime === 'openclaw') {
      if (!/^[a-z0-9][a-z0-9_-]*$/u.test(target.account)) fail('account-required', 'Select an exact normalized, existing channel account.');
      before = await snapshot(target.configPath);
      const config = object(JSON.parse(before.bytes!.toString('utf8')));
      const relay = object(own(object(own(config, 'channels')), 'relay'));
      const accounts = own(relay, 'accounts');
      const slot = accounts && own(object(accounts), target.account) !== undefined
        ? object(own(object(accounts), target.account))
        : target.account === 'default' ? relay : fail('account-missing', 'Create the selected Relay channel account using OpenClaw first.');
      if (relay.enabled === false || slot.enabled === false) fail('channel-disabled', 'Enable the selected Relay channel account explicitly in OpenClaw first.');
      if (target.brain) {
        const bindings = config.bindings;
        if (!Array.isArray(bindings) || !bindings.some((entry: unknown) => {
          const binding = object(entry); const match = object(binding.match);
          return binding.agentId === target.brain && match.channel === 'relay' && match.accountId === target.account;
        })) fail('brain-binding-required', 'Bind the selected Relay channel account to the chosen brain using OpenClaw first. Profiles, brains, and accounts are distinct.');
      }
      if (slot.tokenFile !== undefined || (target.account === 'default' && relay.tokenFile !== undefined)) fail('credential-reference', 'Use the runtime secret-file workflow for this account; this helper will not replace a shared token file.');
      const oldToken = slot.token ?? (target.account === 'default' ? relay.token : undefined);
      if (!oldToken && target.account === 'default') fail('default-scope-required', 'Resolve the implicit default account environment credential with OpenClaw first, or select an explicit named account.');
      if (accounts && Object.entries(object(accounts)).some(([id, value]) => id !== target.account && object(value).token === token)) fail('credential-in-use', 'Another Relay account in this profile already uses this credential; select that account instead.', true);
      if (slot !== relay && relay.token === token && target.account !== 'default') fail('credential-in-use', 'The default Relay account already uses this credential; select that account instead.', true);
      keepIdentity(oldToken, slot.baseUrl ?? relay.baseUrl, token, base);
      // Permission defaults remain untouched, including intentionally unrestricted OpenClaw accounts.
      // Credential-keyed state: gateway.ts:27-31,84-96; state.ts:574-589.
      if (!oldToken) {
        const name = `account-${hash(`transport-${hash(`${base}\0${token}`)}`).slice(0, 24)}.sqlite`;
        // Existing state is never claimed implicitly when configuring an empty slot.
        const root = join(target.stateDir, 'relay');
        validateState = async () => {
          try { await fs.lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          await absentState(join(root, name), []);
        };
        await validateState();
      }
      slot.token = token; slot.baseUrl = base;
      after = oldToken === token && slot.baseUrl === base && JSON.stringify(config) === JSON.stringify(JSON.parse(before.bytes!.toString('utf8')))
        ? before.bytes!.toString('utf8') : `${JSON.stringify(config, null, 2)}\n`;
    } else {
      const directory = target.runtime === 'hermes' ? target.profileHome : target.channelDir;
      if (!isAbsolute(directory)) fail('absolute-path-required', 'Resolve the selected runtime home explicitly.');
      if (target.runtime === 'claude-code') {
        const global = join(target.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'relay');
        if (resolve(directory) === resolve(global)) fail('session-scope-required', 'Select a session-scoped RELAY_CHANNEL_DIR; the global Claude Relay token will not be replaced.');
        if (!target.context.trim()) fail('context-required', 'Select the Claude channel session context explicitly.');
      } else {
        // Profile config is required; no directory creation or installation side effect.
        guards.push(await snapshot(join(directory, 'config.yaml')));
      }
      before = await snapshot(join(directory, '.env'), true);
      const env = envFile(before.bytes?.toString('utf8') ?? '');
      if (target.runtime === 'claude-code') {
        const senders = (env.values.RELAY_ALLOWED_SENDERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
        if (/^\$\{user_config\.[A-Za-z_][A-Za-z0-9_]*\}$/u.test(env.values.RELAY_ALLOWED_SENDERS ?? '') || !senders.length || senders.length > 64 || senders.some(s => s.length > 255 || /[\u0000-\u001f\u007f]/u.test(s))) {
          fail('allowed-senders-required', 'Configure RELAY_ALLOWED_SENDERS with the intended sender UUIDs or exact handles in this session channel directory first. Adding a contact does not grant ownership.');
        }
        if (env.values.RELAY_CHANNEL_SESSION_ID && env.values.RELAY_CHANNEL_SESSION_ID !== target.context) fail('context-conflict', 'This channel directory already belongs to another session context.', true);
      }
      keepIdentity(env.values.RELAY_AGENT_TOKEN, env.values.RELAY_BASE_URL, token, base);
      if (target.runtime === 'hermes') {
        // Non-env YAML credential/state fallbacks cannot be safely inferred without Hermes's profile resolver.
        if (!env.values.RELAY_AGENT_TOKEN) fail('profile-resolution-required', 'Resolve the existing Hermes profile secret/config scope with Hermes first and save its credential in the profile .env; YAML or managed-scope credentials will not be overwritten.');
        if (!env.values.RELAY_BASE_URL || !env.values.RELAY_STATE_DIR) fail('profile-resolution-required', 'Resolve Hermes base URL and state directory through the active profile scope and save explicit RELAY_BASE_URL and RELAY_STATE_DIR values before handoff; YAML fallbacks will not be guessed.');
        const stateDir = env.values.RELAY_STATE_DIR;
        if (!isAbsolute(stateDir) || stateDir.startsWith('~')) fail('state-path-required', 'Resolve the Hermes state directory to an absolute path first.');
        validateState = async () => verifyHermesState(stateDir, token, base, []);
        await verifyHermesState(stateDir, token, base, guards);
      }
      after = env.update({ RELAY_AGENT_TOKEN: token, RELAY_BASE_URL: base,
        ...(target.runtime === 'claude-code' ? { RELAY_CHANNEL_SESSION_ID: target.context } : {}) });
    }
    const plan: RuntimeConnectPlan = Object.freeze({ status: 'ready', code: 'ready', message: 'Private configuration handoff is ready. Stop the selected runtime and explicitly consent before applying.', actions: Object.freeze(['write-selected-runtime-config', 'restart-selected-runtime-manually']) });
    plans.set(plan, { before, after: Buffer.from(after), guards, validateState, applied: false });
    return plan;
  } catch (error) { return Object.freeze({ ...result(error), actions: Object.freeze([]) }) as RuntimeConnectPlan; }
}

async function verifyHermesState(directory: string, token: string, base: string, guards: Snapshot[]): Promise<void> {
  try { await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const binding = await snapshot(join(directory, '.relay-account.json'), true);
  guards.push(binding);
  const dbFile = await snapshot(join(directory, 'inbox.sqlite3'), true);
  guards.push(dbFile);
  if (!binding.bytes && !dbFile.bytes) return;
  if (!binding.bytes || !dbFile.bytes) fail('state-binding-invalid', 'Hermes state is incomplete; verify it with Hermes before handoff.', true);
  const fingerprint = `sha256:${hash(`relay-hermes-token-v1\0${token}`)}`;
  const account = `sha256:${hash(`relay-hermes-account-v1\0${JSON.stringify({ api_origin: base, token_fingerprint: fingerprint })}`)}`;
  const expected = { schema: 'relay-hermes-state-account/v1', api_origin: base, token_fingerprint: fingerprint, account_fingerprint: account };
  const record = object(JSON.parse(binding.bytes.toString('utf8')));
  if (Object.keys(record).length !== 4 || Object.entries(expected).some(([key, value]) => record[key] !== value)) fail('state-binding-mismatch', 'Hermes durable state does not match the resolved credential and origin.', true);
  // Read-only SQLite also checks the binding inside the durable database, not just its sidecar.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile.path, { readOnly: true });
  try {
    const row = db.prepare('SELECT binding_schema, api_origin, token_fingerprint, account_fingerprint FROM relay_state_account WHERE singleton = 1').get();
    if (!row || row.binding_schema !== expected.schema || row.api_origin !== base || row.token_fingerprint !== fingerprint || row.account_fingerprint !== account) fail('state-binding-mismatch', 'Hermes database binding does not match the selected identity.', true);
  } finally { db.close(); }
}

async function replace(before: Snapshot, bytes: Buffer): Promise<Snapshot> {
  const temporary = join(dirname(before.path), `.relay-handoff-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await fs.open(temporary, 'wx', before.mode);
    created = true;
    try { await file.writeFile(bytes); await file.chmod(before.mode); await file.sync(); } finally { await file.close(); }
    if (!await unchanged(before)) fail('changed', 'Configuration changed; plan again without overwriting it.', true);
    if (before.bytes === null) {
      // link is an exclusive no-replace publication for a previously absent file.
      await fs.link(temporary, before.path); await fs.unlink(temporary); created = false;
    } else { await fs.rename(temporary, before.path); created = false; }
    return await snapshot(before.path);
  } finally { if (created) await fs.unlink(temporary).catch(() => undefined); }
}
const consented = (value: RuntimeConnectConsent) => value?.consent === true && value?.runtimeStopped === true;
export async function applyRuntimeConnect(plan: RuntimeConnectPlan, consent: RuntimeConnectConsent): Promise<RuntimeConnectResult> {
  if (!consented(consent)) return { status: 'required-action', code: 'consent-required', message: 'Stop the selected runtime and explicitly consent to configuration changes.' };
  const state = plans.get(plan);
  if (!state || state.applied) return { status: 'required-action', code: 'plan-required', message: 'Create a fresh in-process handoff plan before applying.' };
  state.applied = true;
  try {
    return await locked(state.before.path, async () => {
      await state.validateState();
      for (const guard of state.guards) if (!await unchanged(guard)) fail('state-changed', 'Runtime state changed; stop the selected runtime and plan again.', true);
      if (!await unchanged(state.before)) fail('changed', 'Configuration changed; plan again.', true);
      const applied = state.before.bytes?.equals(state.after) ? state.before : await replace(state.before, state.after);
      let rolledBack = false;
      return { status: 'configured', code: 'configured', message: 'Selected runtime configuration saved. Start it using its native workflow; no runtime was started.', rollback: async (approval) => {
        if (!consented(approval)) return { status: 'required-action', code: 'consent-required', message: 'Stop the selected runtime and explicitly consent to rollback.' };
        try {
          return await locked(state.before.path, async () => {
          if (rolledBack) fail('rollback-used', 'Rollback has already been applied.', true);
          if (!await unchanged(applied)) fail('changed', 'Configuration changed after handoff; rollback will not overwrite it.', true);
          if (state.before.bytes === null) await fs.unlink(applied.path);
          else if (!state.before.bytes.equals(state.after)) await replace(applied, state.before.bytes);
          rolledBack = true;
          return { status: 'configured', code: 'rolled-back', message: 'Original configuration restored; durable runtime state was not modified.' };
          });
        } catch (error) { return result(error); }
      } };
    });
  } catch (error) { return result(error); }
}

async function locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await safeParents(path);
  const lockPath = join(dirname(path), '.relay-handoff.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('handoff-locked', 'Another handoff holds this directory lock. Do not remove it until that operation is confirmed stopped.', true);
    throw error;
  }
  try { return await operation(); }
  finally { await lock.close(); await fs.unlink(lockPath); }
}
