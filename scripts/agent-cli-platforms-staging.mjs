#!/usr/bin/env node
// Staging HTTP protocol proof, not a substitute for native CLI/SDK integration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
export const STAGING_ORIGIN = 'https://api.staging.relayapp.im';
export const PLAN = [
  'Create exactly two named test fixtures; never retry bootstrap',
  'Read each own Contact Card to form the local fixture inventory (no GET-list API)',
  'Reject missing/invalid authentication and cross-fixture card access/deletion',
  'Delete only fixtures created by this run, once each; verify token revocation',
  'Retain private recovery state if cleanup is unconfirmed; never touch operator data',
];
export async function runOwnedSmoke({ runId, serverSha, fetchImpl = fetch, saveReceipt = () => {}, savePrivate = () => {}, provenance = {} }) {
  assert.match(runId, /^[a-z0-9][a-z0-9-]{0,39}$/);
  assert.match(serverSha, /^[a-f0-9]{40}$/);
  const fixtures = [];
  const secrets = [];
  const receipt = { runId, serverSha, provenance, origin: STAGING_ORIGIN, proof: 'staging HTTP only; CLI list/runtime not claimed', requests: [], fixtures: [], uncertainCreations: [], failures: [] };
  const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]').split(JSON.stringify(secret).slice(1,-1)).join('[REDACTED]'), JSON.stringify(value));
  const snapshot = () => JSON.parse(redact(receipt));
  const persist = () => { savePrivate({ runId, serverSha, origin: STAGING_ORIGIN, fixtures, uncertainCreations: receipt.uncertainCreations }); saveReceipt(snapshot()); };
  async function request(step, method, path, token, body) {
    assert.ok(path.startsWith('/v1/'));
    const url = new URL(path, STAGING_ORIGIN);
    assert.equal(url.origin, STAGING_ORIGIN);
    const row = { step, method, path };
    receipt.requests.push(row);
    saveReceipt(snapshot());
    try {
      const response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      row.status = response.status;
      saveReceipt(snapshot());
      return response;
    } catch {
      row.error = 'transport failure; request outcome may be uncertain';
      saveReceipt(snapshot());
      throw Error(`${step}: transport failure; no automatic retry`);
    }
  }
  const json = async response => {
    try { return await response.json(); }
    catch { throw Error('Response JSON invalid; body omitted to protect credentials'); }
  };
  const expectStatus = (response, expected, step) => assert.equal(response.status, expected, `${step}: unexpected HTTP status`);
  async function ownCard(fixture, step) {
    const response = await request(step, 'GET', '/v1/contact_card', fixture.token);
    expectStatus(response, 200, step);
    const body = await json(response);
    assert.ok(Array.isArray(body.contact_cards) && body.contact_cards.length > 0, `${step}: missing cards`);
    assert.ok(body.contact_cards.every(card => card.handle === fixture.handle), `${step}: unexpected identity in own-card response`);
  }
  try {
    persist(); // Prove recovery-state storage before minting anything.
    for (const suffix of ['a', 'b']) {
      const tokenName = `verification-agent-cli-${runId}-${suffix}`;
      receipt.uncertainCreations.push({ tokenName }); persist();
      const response = await request(`create-${suffix}`, 'POST', '/v1/agents', undefined, { token_name: tokenName });
      expectStatus(response, 201, `create-${suffix}`);
      const body = await json(response);
      assert.ok(typeof body.secret === 'string' && body.secret.length > 0, 'creation omitted one-time credential');
      secrets.push(body.secret);
      assert.match(body.agent?.handle ?? '', /^[a-z0-9_]+\.dev$/, 'creation returned unexpected developer handle');
      const fixture = { label: tokenName, handle: body.agent.handle, token: body.secret, deleteAttempted: false, deleted: false, revocationConfirmed: false };
      fixtures.push(fixture);
      receipt.fixtures.push({ label: tokenName, handle: fixture.handle });
      receipt.uncertainCreations = receipt.uncertainCreations.filter(x => x.tokenName !== tokenName);
      persist();
      assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/, 'bootstrap must not be cached');
      assert.equal(body.agent.kind, 'agent'); assert.equal(body.agent.is_active, true);
      const share = new URL(body.share_url);
      assert.equal(share.origin, 'https://go.staging.relayapp.im');
      assert.equal(decodeURIComponent(share.pathname), `/@${fixture.handle}`);
    }
    assert.notEqual(fixtures[0].handle, fixtures[1].handle, 'bootstrap reused an identity');
    expectStatus(await request('missing-auth', 'GET', '/v1/contact_card'), 401, 'missing-auth');
    expectStatus(await request('invalid-auth', 'GET', '/v1/contact_card', 'synthetic-invalid-staging-smoke-token'), 401, 'invalid-auth');
    for (const fixture of fixtures) await ownCard(fixture, `inventory-${fixture.handle}`);
    const [a,b] = fixtures;
    expectStatus(await request('foreign-card', 'GET', `/v1/contact_card?handle=${encodeURIComponent(b.handle)}`, a.token), 403, 'foreign-card');
    expectStatus(await request('foreign-delete', 'DELETE', `/v1/agents/${encodeURIComponent(b.handle)}`, a.token), 403, 'foreign-delete');
    await ownCard(b, 'foreign-delete-preserved-target');
  } catch (error) {
    receipt.failures.push(error.message);
  } finally {
    // Only identities whose handles and one-time credentials came from THIS run.
    for (const fixture of fixtures) {
      if (fixture.deleteAttempted) continue;
      fixture.deleteAttempted = true;
      try {
        persist();
        const response = await request(`cleanup-${fixture.handle}`, 'DELETE', `/v1/agents/${encodeURIComponent(fixture.handle)}`, fixture.token);
        expectStatus(response, 204, 'owned cleanup');
        fixture.deleted = true; persist();
        expectStatus(await request(`revoked-${fixture.handle}`, 'GET', '/v1/contact_card', fixture.token), 401, 'revoked token');
        fixture.revocationConfirmed = true; persist();
      } catch (error) { receipt.failures.push(error.message); }
    }
    receipt.cleanup = fixtures.map(({ handle, deleted }) => ({ handle, confirmed: deleted }));
    receipt.recoveryRequired = receipt.uncertainCreations.length > 0 || fixtures.some(x => !x.deleted || !x.revocationConfirmed);
    receipt.result = receipt.failures.length || receipt.recoveryRequired ? 'failed' : 'passed';
    persist();
  }
  return snapshot();
}
async function main() {
  const { values } = parseArgs({ options: {
    execute: { type: 'boolean', default: false }, 'run-id': { type: 'string' },
    'server-sha': { type: 'string' }, receipt: { type: 'string' }, 'private-state': { type: 'string' },
  } });
  if (!values.execute) { console.log(JSON.stringify({ origin: STAGING_ORIGIN, requestsSent: 0, plan: PLAN }, null, 2)); return; }
  assert.equal(process.platform, 'linux', 'Execute live proof only in Daytona');
  assert.ok(process.env.RELAY_DAYTONA_SANDBOX_ID, 'Owned Daytona sandbox ID is required');
  assert.ok(values.receipt && values['private-state'], 'Explicit receipt and private-state paths are required');
  assert.ok(isAbsolute(values['private-state']), 'Private state must be absolute');
  const privatePath = resolve(values['private-state']);
  assert.ok(!privatePath.includes('/_artifacts/') && !privatePath.includes('/.release-tmp/'), 'Never store credentials in artifacts');
  assert.ok(!existsSync(privatePath), 'Existing private state must be reviewed, never overwritten');
  const receiptPath = resolve(values.receipt);
  assert.notEqual(receiptPath, privatePath);
  mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
  writeFileSync(privatePath, '{}\n', { flag: 'wx', mode: 0o600 });
  mkdirSync(dirname(receiptPath), { recursive: true });
  const scriptPath = fileURLToPath(import.meta.url);
  const sourceRoot = resolve(dirname(scriptPath), '..');
  const harnessSha = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const harnessDirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  assert.match(harnessSha, /^[a-f0-9]{40}$/);
  const provenance = { harnessSha, harnessDirty, scriptSHA256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
    platform: process.platform, arch: process.arch, node: process.version, sandbox: process.env.RELAY_DAYTONA_SANDBOX_ID, serverShaSource: 'deployment SHA supplied by main' };
  const result = await runOwnedSmoke({ provenance, runId: values['run-id'], serverSha: values['server-sha'],
    saveReceipt: value => writeFileSync(receiptPath, JSON.stringify(value, null, 2)),
    savePrivate: value => {
      const temporary = `${privatePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, privatePath); chmodSync(privatePath, 0o600);
    },
  });
  if (!result.recoveryRequired) unlinkSync(privatePath);
  console.log(JSON.stringify({ result: result.result, receipt: receiptPath, recoveryRequired: result.recoveryRequired }));
  if (result.result !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Staging smoke failed before completion; inspect safe receipt/private recovery state.'); process.exitCode = 1; });
}
