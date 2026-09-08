import { inspectWindowsAcl, privateWindowsAcl, protectWindowsPath } from "./windows-acl.js";
import { parseDocument } from "yaml";
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeConnectConsent, RuntimeConnectInput, RuntimeConnectPlan, RuntimeConnectResult } from '../runtime-connect.js';

type Json = Record<string, unknown>;
type Snapshot = { path: string; bytes: Buffer | null; mode: number; ino: number; dev: number; metadata: boolean; acl?: string };
type PrivatePlan = { before: Snapshot; after: Buffer; guards: Snapshot[]; validateState: () => Promise<void>; applied: boolean };
const plans = new WeakMap<RuntimeConnectPlan, PrivatePlan>();
class Action extends Error { constructor(readonly code: string, message: string, readonly conflict = false) { super(message); } }
function fail(code: string, message: string, conflict = false): never { throw new Action(code, message, conflict); }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-config', 'This configuration file must hold a JSON object. Fix the file, then run this command again.');
  return value as Json;
};
const own = (value: Json, key: string) => Object.hasOwn(value, key) ? value[key] : undefined;
function origin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    fail('invalid-origin', 'The Relay API address must start with https:// and have nothing after the host name. Use http:// only for localhost in tests.');
  }
  return url.origin;
}
async function safeParents(path: string): Promise<void> {
  if (!isAbsolute(path)) fail('absolute-path-required', 'Give a full path that starts at the root of the disk.');
  const parent = await fs.lstat(dirname(path));
  if (process.platform === 'win32' && !privateWindowsAcl(await inspectWindowsAcl(dirname(path)), true)) fail('unsafe-directory', 'Other Windows accounts can write to that folder. Choose a folder only your account can write to.');
  if (process.platform !== 'win32' && ((parent.mode & 0o022) !== 0 || parent.uid !== process.getuid?.())) fail('unsafe-directory', 'The folder holding this configuration file must belong to you, and nobody else may write to it.');
  for (let current = dirname(path); ; current = dirname(current)) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-path', 'The path to this configuration file goes through a link. Give a path made only of real folders.');
    if (dirname(current) === current) break;
  }
}
async function snapshot(path: string, optional = false, metadata = false): Promise<Snapshot> {
  await safeParents(path);
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe-file', 'The configuration file must be a regular file, not a link, and it must not be hard-linked from anywhere else.');
    // Do not widen, silently tighten, or copy shared secret permissions.
    if (process.platform !== 'win32' && ((stat.mode & (metadata ? 0o022 : 0o077)) !== 0 || stat.uid !== process.getuid?.())) {
      fail('private-file-required', 'Only you may read or write this configuration file. Fix its permissions, then run this command again.');
    }
    const acl = process.platform === 'win32' ? await inspectWindowsAcl(path) : undefined;
    if (acl && !privateWindowsAcl(acl, false, metadata)) fail('private-file-required', 'Windows permissions on that file let other accounts read or write it. Limit it to your account, then run this command again.');
    const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) fail('changed', 'The configuration file changed while this command was reading it. Run the command again.', true);
      return { path, bytes: await file.readFile(), mode: stat.mode & 0o777, ino: stat.ino, dev: stat.dev, metadata, ...(acl ? { acl: acl.sddl } : {}) };
    } finally { await file.close(); }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return { path, bytes: null, mode: process.platform === 'win32' ? 0o666 : 0o600, ino: 0, dev: 0, metadata };
    throw error;
  }
}
async function unchanged(before: Snapshot): Promise<boolean> {
  const now = await snapshot(before.path, true, before.metadata);
  return now.acl === before.acl && now.mode === before.mode && now.ino === before.ino && now.dev === before.dev &&
    (now.bytes === null ? before.bytes === null : before.bytes !== null && now.bytes.equals(before.bytes));
}
function envFile(text: string, escaped = false): { values: Record<string, string>; update: (changes: Record<string, string>) => string } {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const lines = text.split(/\r?\n/u);
  const indices = new Map<string, number>();
  lines.forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) fail('complex-env', 'A line in this .env file is not a plain NAME=value line. Simplify it, then run this command again.');
    const key = match[1];
    if (indices.has(key)) fail('duplicate-env', 'This .env file sets the same name twice. Remove the duplicate, then run this command again.');
    let value = match[2].trim();
    if (value.startsWith('\"') && value.endsWith('\"')) { value = value.slice(1, -1); if (escaped) value = value.replace(/\\([\\"])/gu, '$1'); }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else if (/\s#/u.test(value)) fail('complex-env', 'A value in this .env file has a comment on the same line. Move the comment to its own line, then run this command again.');
    if (/[\r\n\u0000]/u.test(value)) fail('complex-env', 'A value in this .env file contains a line break. Fix it, then run this command again.');
    values[key] = value;
    indices.set(key, index);
  });
  return { values, update(changes) {
    const output = [...lines];
    for (const [key, value] of Object.entries(changes)) {
      if (values[key] === value) continue;
      if (/[\r\n\u0000"'`$]/u.test(value)) fail('unsafe-env-value', 'This value cannot be written to a .env file safely. Use a value with no quotes, backticks, dollar signs or line breaks.');
      const line = `${key}="${escaped ? value.replaceAll('\\', '\\\\') : value}"`;
      const index = indices.get(key);
      if (index !== undefined) output[index] = line;
      else { if (output.at(-1) === '') output.pop(); output.push(line, ''); }
    }
    return output.join(text.includes('\r\n') ? '\r\n' : '\n');
  } };
}
function keepIdentity(oldToken: unknown, oldOrigin: unknown, token: string, base: string): void {
  if (oldToken !== undefined && typeof oldToken !== 'string') fail('token-stored-elsewhere', 'This configuration points at a token held somewhere else. Clear that in the runtime you chose, then run this command again.');
  if (typeof oldToken === 'string' && oldToken.trim() &&
    (oldToken.trim() !== token || origin(typeof oldOrigin === 'string' ? oldOrigin : 'https://api.relayapp.im') !== base)) {
    fail('different-agent', 'This account already holds a different token or a different Relay API address. Use another account, or move its saved data yourself first.', true);
  }
}
function result(error: unknown): RuntimeConnectResult {
  return error instanceof Action
    ? { status: error.conflict ? 'conflict' : 'required-action', code: error.code, message: error.message }
    : { status: 'required-action', code: 'inspection-failed', message: 'Relay could not read or write the configuration for the runtime you chose. Check the paths you passed, the contents of the file and its permissions, then run this command again.' };
}
async function safeStateDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) fail('state-path-required', 'Give a full path to the folder where the runtime you chose keeps its saved data.');
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-path', 'That path must be a real folder. It is a file or a link.');
    await safeParents(join(directory, 'binding'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await safeParents(directory);
  }
}

async function absentState(path: string, guards: Snapshot[]): Promise<void> {
  const state = await snapshot(path, true);
  guards.push(state);
  if (state.bytes !== null) fail('saved-data-present', 'The runtime you chose already keeps saved data here. Check whose data it is in that runtime before you change the token. Nothing was changed.', true);
}

export async function planRuntimeConnect(input: RuntimeConnectInput): Promise<RuntimeConnectPlan> {
  try {
    const token = input.agent.token;
    if (!token || token !== token.trim() || token.length > 4096 || /[\u0000-\u0020\u007f]/u.test(token)) fail('invalid-token', 'The token is missing, or it has spaces or characters it must not have. Pass a valid token. No agent was created.');
    const base = origin(input.agent.origin);
    const target = input.target;
    const guards: Snapshot[] = [];
    let validateState: () => Promise<void> = async () => undefined;
    let before: Snapshot;
    let after: string;
    if (target.runtime === 'openclaw') {
      if (['constructor', 'prototype', '__proto__'].includes(target.account)) fail('account-missing', 'That account name is reserved. Choose another name.');
      if (!/^[a-z0-9][a-z0-9_-]*$/u.test(target.account)) fail('account-required', 'An account name may use only lowercase letters, numbers, dashes and underscores, and must start with a letter or a number.');
      before = await snapshot(target.configPath);
      const config = object(JSON.parse(before.bytes!.toString('utf8')));
      const channels = config.channels === undefined ? (config.channels = {}) as Json : object(config.channels);
      const relay = channels.relay === undefined ? (channels.relay = {}) as Json : object(channels.relay);
      const accounts = own(relay, 'accounts');
      const slot = accounts && own(object(accounts), target.account) !== undefined
        ? object(own(object(accounts), target.account))
        : target.account === 'default' ? relay : (() => {
          const selectedAccounts = accounts === undefined ? (relay.accounts = {}) as Json : object(accounts);
          return (selectedAccounts[target.account] = {}) as Json;
        })();
      if (relay.enabled === false || slot.enabled === false) fail('channel-disabled', 'This Relay account is turned off in OpenClaw. Turn it on there, then run this command again.');
      if (target.brain) {
        const bindings = config.bindings;
        if (!Array.isArray(bindings) || !bindings.some((entry: unknown) => {
          const binding = object(entry); const match = object(binding.match);
          return binding.agentId === target.brain && match.channel === 'relay' && match.accountId === target.account;
        })) fail('brain-binding-required', 'OpenClaw does not link this Relay account to that brain. Link them in OpenClaw, then run this command again.');
      }
      if (slot.tokenFile !== undefined || (target.account === 'default' && relay.tokenFile !== undefined)) fail('token-stored-elsewhere', 'This account reads its token from a separate file. Change that file in OpenClaw yourself; Relay will not overwrite it.');
      const oldToken = slot.token ?? (target.account === 'default' ? relay.token : undefined);
      if (!oldToken && target.account === 'default') {
        // The default account alone falls back to native environment credentials.
        const nativeEnv = await snapshot(join(dirname(target.configPath), '.env'), true);
        guards.push(nativeEnv);
        const fromFile = envFile(nativeEnv.bytes?.toString('utf8') ?? '').values.RELAY_AGENT_TOKEN;
        const configuredEnv = config.env === undefined ? {} : object(config.env);
        const vars = configuredEnv.vars === undefined ? {} : object(configuredEnv.vars);
        for (const ambient of [process.env.RELAY_AGENT_TOKEN, fromFile, configuredEnv.RELAY_AGENT_TOKEN, vars.RELAY_AGENT_TOKEN]) {
          if (ambient !== undefined && ambient !== '' && ambient !== token) fail('default-scope-required', 'The default account already picks up a different token from its environment. Clear that token in OpenClaw, then run this command again.');
        }
      }
      if (accounts && Object.entries(object(accounts)).some(([id, value]) => id !== target.account && object(value).token === token)) fail('credential-in-use', 'Another Relay account in this OpenClaw file already uses this token. Choose that account instead.', true);
      if (slot !== relay && relay.token === token && target.account !== 'default') fail('credential-in-use', 'The default Relay account already uses this token. Choose the default account instead.', true);
      keepIdentity(oldToken, slot.baseUrl ?? relay.baseUrl, token, base);
      // Permission defaults remain untouched, including intentionally unrestricted OpenClaw accounts.
      // Credential-keyed state: gateway.ts:27-31,84-96; state.ts:574-589.
      if (!oldToken) {
        const name = `account-${hash(`transport-${hash(`${base}\0${token}`)}`).slice(0, 24)}.sqlite`;
        // Existing state is never claimed implicitly when configuring an empty slot.
        const root = join(target.stateDir, 'relay');
        validateState = async () => {
          await safeStateDirectory(target.stateDir);
          try { await fs.lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          for (const suffix of ['', '-wal', '-shm']) await absentState(join(root, name + suffix), []);
        };
        await validateState();
      }
      slot.token = token; slot.baseUrl = base;
      after = oldToken === token && slot.baseUrl === base && JSON.stringify(config) === JSON.stringify(JSON.parse(before.bytes!.toString('utf8')))
        ? before.bytes!.toString('utf8') : `${JSON.stringify(config, null, 2)}\n`;
    } else {
      const directory = target.runtime === 'hermes' ? target.profileHome : target.channelDir;
      if (!isAbsolute(directory)) fail('absolute-path-required', 'Give a full path to the folder for the runtime you chose.');
      if (target.runtime === 'claude-code') {
        const global = join(target.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'relay');
        if (resolve(directory) === resolve(global)) fail('session-scope-required', 'That is the shared Claude Code folder. Choose a folder for this one session; Relay will not replace the shared token.');
        if (!target.context.trim()) fail('context-required', 'Pass --runtime-context with the name of this Claude Code session.');
      } else {
        // Profile config is required; no directory creation or installation side effect.
        guards.push(await snapshot(join(directory, 'config.yaml'), false, true));
      }
      before = await snapshot(join(directory, '.env'), true);
      const env = envFile(before.bytes?.toString('utf8') ?? '', target.runtime === 'hermes');
      if (target.runtime === 'claude-code') {
        const senders = (env.values.RELAY_ALLOWED_SENDERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
        if (/^\$\{user_config\.[A-Za-z_][A-Za-z0-9_]*\}$/u.test(env.values.RELAY_ALLOWED_SENDERS ?? '') || !senders.length || senders.length > 64 || senders.some(s => s.length > 255 || /[\u0000-\u001f\u007f]/u.test(s))) {
          fail('allowed-senders-required', 'Set RELAY_ALLOWED_SENDERS in this folder\'s .env file to the handles or ids allowed to message this agent, then run this command again.');
        }
        if (env.values.RELAY_CHANNEL_SESSION_ID && env.values.RELAY_CHANNEL_SESSION_ID !== target.context) fail('context-conflict', 'This folder already belongs to a different Claude Code session. Choose another folder.', true);
      }
      keepIdentity(env.values.RELAY_AGENT_TOKEN, env.values.RELAY_BASE_URL, token, base);
      if (target.runtime === 'hermes') {
        const yaml = parseDocument(guards[0]!.bytes!.toString('utf8'), { uniqueKeys: true });
        if (yaml.errors.length || yaml.warnings.length) fail('profile-resolution-required', 'Hermes could not read config.yaml in this profile. Fix that file in Hermes, then run this command again.');
        const config = object(yaml.toJS({ maxAliasCount: 0 }));
        const gateway = config.gateway === undefined ? {} : object(config.gateway);
        const platforms = gateway.platforms === undefined ? {} : object(gateway.platforms);
        const relayConfig = platforms.relayapp === undefined ? {} : object(platforms.relayapp);
        const extra = relayConfig.extra === undefined ? {} : object(relayConfig.extra);
        if (relayConfig.enabled === false) fail('channel-disabled', 'Relay is turned off in this Hermes profile. Turn it on in Hermes, then run this command again.');
        // Inspect the native YAML fallback, but never rewrite it or its permissions.
        const configuredToken = env.values.RELAY_AGENT_TOKEN || extra.token;
        keepIdentity(configuredToken, env.values.RELAY_BASE_URL || extra.base_url || extra.api_url, token, base);
        if (configuredToken && !env.values.RELAY_AGENT_TOKEN) fail('profile-resolution-required', 'This Hermes profile keeps its token in config.yaml. Move it into the profile\'s .env file, then run this command again.');
        const stateDir = target.stateDir ?? env.values.RELAY_STATE_DIR;
        if (!stateDir || !isAbsolute(stateDir) || stateDir.startsWith('~')) fail('state-path-required', 'Pass --runtime-state-dir with a full path to the folder where Hermes keeps its saved data.');
        const existingStateDir = env.values.RELAY_STATE_DIR || extra.state_dir;
        if (existingStateDir && existingStateDir !== stateDir) fail('state-path-conflict', 'This Hermes profile already uses a different data folder. Nothing was moved.', true);
        if (!configuredToken) {
          validateState = async () => {
            await safeStateDirectory(stateDir);
            try { await fs.lstat(stateDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
            for (const name of ['.relay-account.json', 'inbox.sqlite3', 'inbox.sqlite3-wal', 'inbox.sqlite3-shm']) await absentState(join(stateDir, name), []);
          };
          await validateState();
        } else {
          validateState = async () => verifyHermesState(stateDir, token, base, []);
          await verifyHermesState(stateDir, token, base, guards);
        }
        env.values.RELAY_STATE_DIR = env.values.RELAY_STATE_DIR ?? '';
      } else if (!env.values.RELAY_AGENT_TOKEN) {
        validateState = async () => {
          try {
            const statePath = join(directory, 'state');
            await safeParents(join(statePath, 'binding'));
            if ((await fs.readdir(statePath)).length) fail('saved-data-present', 'This Claude Code folder has no token yet but already holds saved data. Check which agent it belongs to before you connect one.', true);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        };
        await validateState();
      }
      after = env.update({ RELAY_AGENT_TOKEN: token, RELAY_BASE_URL: base,
        ...(target.runtime === 'claude-code' ? { RELAY_CHANNEL_SESSION_ID: target.context } : { RELAY_STATE_DIR: target.stateDir ?? env.values.RELAY_STATE_DIR! }) });
    }
    const plan: RuntimeConnectPlan = Object.freeze({ status: 'ready', code: 'ready', message: 'Relay is ready to write the configuration. Stop the runtime you chose, then confirm.', actions: Object.freeze(['Write the configuration for the runtime you chose', 'Start that runtime again yourself']) });
    plans.set(plan, { before, after: Buffer.from(after), guards, validateState, applied: false });
    return plan;
  } catch (error) { return Object.freeze({ ...result(error), actions: Object.freeze([]) }) as RuntimeConnectPlan; }
}

async function verifyHermesState(directory: string, token: string, base: string, guards: Snapshot[]): Promise<void> {
  await safeStateDirectory(directory);
  try { await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const binding = await snapshot(join(directory, '.relay-account.json'), true);
  guards.push(binding);
  const dbFile = await snapshot(join(directory, 'inbox.sqlite3'), true);
  guards.push(dbFile);
  if (!binding.bytes && !dbFile.bytes) return;
  if (!binding.bytes || !dbFile.bytes) fail('state-binding-invalid', 'The data Hermes saved here is incomplete: one of its two files is missing. Check it in Hermes first.', true);
  const fingerprint = `sha256:${hash(`relay-hermes-token-v1\0${token}`)}`;
  const account = `sha256:${hash(`relay-hermes-account-v1\0${JSON.stringify({ api_origin: base, token_fingerprint: fingerprint })}`)}`;
  const expected = { schema: 'relay-hermes-state-account/v1', api_origin: base, token_fingerprint: fingerprint, account_fingerprint: account };
  const record = object(JSON.parse(binding.bytes.toString('utf8')));
  if (Object.keys(record).length !== 4 || Object.entries(expected).some(([key, value]) => record[key] !== value)) fail('state-binding-mismatch', 'The data Hermes saved here belongs to a different token or a different Relay API address.', true);
  // Read-only SQLite also checks the binding inside the durable database, not just its sidecar.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile.path, { readOnly: true });
  try {
    const row = db.prepare('SELECT binding_schema, api_origin, token_fingerprint, account_fingerprint FROM relay_state_account WHERE singleton = 1').get();
    if (!row || row.binding_schema !== expected.schema || row.api_origin !== base || row.token_fingerprint !== fingerprint || row.account_fingerprint !== account) fail('state-binding-mismatch', 'The Hermes database here belongs to a different agent.', true);
  } finally { db.close(); }
}

async function replace(before: Snapshot, bytes: Buffer): Promise<Snapshot> {
  const temporary = join(dirname(before.path), `.relay-connect-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await fs.open(temporary, 'wx', before.mode);
    created = true;
    try {
      if (process.platform === 'win32') {
        const acl = await protectWindowsPath(temporary, false, before.acl);
        if (!privateWindowsAcl(acl)) fail('private-file-required', 'Windows permissions on the new file could not be limited to your account, so nothing was written.');
      }
      await file.writeFile(bytes);
      if (process.platform !== 'win32') await file.chmod(before.mode);
      await file.sync();
    } finally { await file.close(); }
    if (!await unchanged(before)) fail('changed', 'The configuration file changed while this command was running. Nothing was written. Run the command again.', true);
    if (before.bytes === null) {
      // link is an exclusive no-replace publication for a previously absent file.
      await fs.link(temporary, before.path); await fs.unlink(temporary); created = false;
    } else { await fs.rename(temporary, before.path); created = false; }
    return await snapshot(before.path);
  } finally { if (created) await fs.unlink(temporary).catch(() => undefined); }
}
const consented = (value: RuntimeConnectConsent) => value?.consent === true && value?.runtimeStopped === true;
export async function applyRuntimeConnect(plan: RuntimeConnectPlan, consent: RuntimeConnectConsent): Promise<RuntimeConnectResult> {
  if (!consented(consent)) return { status: 'required-action', code: 'consent-required', message: 'Stop the runtime you chose, then pass --confirm-configure and --runtime-stopped.' };
  const state = plans.get(plan);
  if (!state || state.applied) return { status: 'required-action', code: 'plan-required', message: 'This plan was already used. Run the command again.' };
  state.applied = true;
  try {
    return await locked(state.before.path, async () => {
      await state.validateState();
      for (const guard of state.guards) if (!await unchanged(guard)) fail('state-changed', 'The runtime you chose changed its files while this command was running. Stop it, then run this command again.', true);
      if (!await unchanged(state.before)) fail('changed', 'The configuration file changed while this command was running. Run the command again.', true);
      const applied = state.before.bytes?.equals(state.after) ? state.before : await replace(state.before, state.after);
      let rolledBack = false;
      return { status: 'configured', code: 'configured', message: 'Configuration saved. Start the runtime you chose yourself; Relay did not start it.', rollback: async (approval) => {
        if (!consented(approval)) return { status: 'required-action', code: 'consent-required', message: 'Stop the runtime you chose, then confirm before undoing this change.' };
        try {
          return await locked(state.before.path, async () => {
          if (rolledBack) fail('rollback-used', 'This change was already undone.', true);
          if (!await unchanged(applied)) fail('changed', 'The configuration file changed after Relay wrote it. The undo was stopped so it would not overwrite your change.', true);
          if (state.before.bytes === null) await fs.unlink(applied.path);
          else if (!state.before.bytes.equals(state.after)) await replace(applied, state.before.bytes);
          rolledBack = true;
          return { status: 'configured', code: 'rolled-back', message: 'The original configuration is back. Saved data for the runtime you chose was not touched.' };
          });
        } catch (error) { return result(error); }
      } };
    });
  } catch (error) { return result(error); }
}

async function locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await safeParents(path);
  const lockPath = join(dirname(path), '.relay-connect.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('locked-by-another-command', 'Another Relay command is writing in this folder. Wait for it to finish; do not delete its lock file.', true);
    throw error;
  }
  try { return await operation(); }
  finally { await lock.close(); await fs.unlink(lockPath); }
}
