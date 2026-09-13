#!/usr/bin/env node
// Staging HTTP protocol proof, not a substitute for native CLI/SDK integration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
const uuidv7 = () => {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const STAGING_ORIGIN = 'https://api.staging.relayapp.im';
export const STAGING_CONSOLE_API = 'https://console.staging.relayapp.im/api';
export const PLAN = [
  'Create exactly two named Console-owned test fixtures with the saved organization key; never retry creation',
  'Read each own Contact Card to form the local fixture inventory (no GET-list API)',
  'Reject missing/invalid authentication and cross-fixture card access/deletion',
  'Delete only fixtures created by this run, once each; verify token revocation',
  'Retain private recovery state if cleanup is unconfirmed; never touch operator data',
];
export function canonicalRulesFromYaml(text) {
  const spec = YAML.parse(text);
  assert.equal(spec?.paths?.['/v1/agents'], undefined, 'Anonymous registration must be absent');
  assert.equal(spec?.components?.schemas?.CreateAgentRequest, undefined);
  assert.equal(spec?.components?.schemas?.CreateAgentResponse, undefined);
  const remove = spec?.paths?.['/v1/agents/{handle}']?.delete;
  const card = spec?.paths?.['/v1/contact_card']?.get;
  assert.equal(remove?.operationId, 'deleteAgent', 'Canonical deleteAgent operation missing');
  assert.deepEqual(remove.security, [{ BearerAuth: [] }], 'Canonical delete auth changed');
  assert.equal(card?.operationId, 'getContactCard', 'Canonical Contact Card operation missing');
  return { anonymousRegistration: false };

}
export async function runOwnedSmoke({ runId, serverSha, fetchImpl = fetch, saveReceipt = () => {}, savePrivate = () => {}, provenance = {}, canonicalRules, organizationKey }) {
  assert.match(runId, /^[a-z0-9][a-z0-9-]{0,39}$/);
  assert.match(serverSha, /^[a-f0-9]{40}$/);
  const fixtures = [];
  assert.match(organizationKey ?? '', /^(?:rel_org_|rly_org_)\S+$/);
  const secrets = [organizationKey];
  let organization;
  const receipt = { runId, serverSha, provenance, origin: STAGING_ORIGIN, proof: 'staging HTTP only; CLI list/runtime not claimed', requests: [], fixtures: [], uncertainCreations: [], failures: [] };
  const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]').split(JSON.stringify(secret).slice(1,-1)).join('[REDACTED]'), JSON.stringify(value));
  const snapshot = () => JSON.parse(redact(receipt));
  const persist = () => { savePrivate({ runId, serverSha, origin: STAGING_ORIGIN, fixtures, uncertainCreations: receipt.uncertainCreations }); saveReceipt(snapshot()); };
  async function request(step, method, path, token, body) {
    assert.ok(path.startsWith('/v1/') || path === '/me' || path.startsWith('/orgs/'));
    const url = path.startsWith('/v1/') ? new URL(path, STAGING_ORIGIN) : new URL(STAGING_CONSOLE_API + path);
    const row = { step, method, path };
    receipt.requests.push(row);
    saveReceipt(snapshot());
    try {
      const response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method === 'POST' ? { 'Idempotency-Key': uuidv7() } : {}),
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
    const me = await request('organization', 'GET', '/me', organizationKey);
    expectStatus(me, 200, 'organization');
    organization = (await json(me)).org;
    assert.ok(organization?.id && organization?.handleNamespace, 'Console organization is incomplete');
    for (const suffix of ['a', 'b']) {
      const tokenName = `verification-agent-cli-${runId}-${suffix}`;
      const handle = `proof_${runId.slice(0,18).replaceAll('-', '_')}_${suffix}.${organization.handleNamespace}`;
      receipt.uncertainCreations.push({ tokenName, handle }); persist();
      const response = await request(`create-${suffix}`, 'POST', `/orgs/${organization.id}/agents`, organizationKey,
        { handle, displayName: tokenName, isPremiumHandle: false });
      expectStatus(response, 201, `create-${suffix}`);
      const body = await json(response);
      assert.ok(typeof body.token === 'string' && body.token.length > 0, 'creation omitted one-time credential');
      secrets.push(body.token);
      assert.ok(body.agent?.id && body.agent.handle === handle, 'Console returned an unexpected agent');
      const fixture = { label: tokenName, id: body.agent.id, handle, token: body.token, deleteAttempted: false, deleted: false, revocationConfirmed: false };
      fixtures.push(fixture);
      receipt.fixtures.push({ label: tokenName, handle });
      receipt.uncertainCreations = receipt.uncertainCreations.filter(x => x.tokenName !== tokenName);
      persist();
    }
    assert.notEqual(fixtures[0].handle, fixtures[1].handle, 'Console reused an identity');
    expectStatus(await request('missing-auth', 'GET', '/v1/contact_card'), 401, 'missing-auth');
    expectStatus(await request('invalid-auth', 'GET', '/v1/contact_card', 'synthetic-invalid-staging-smoke-token'), 401, 'invalid-auth');
    for (const fixture of fixtures) await ownCard(fixture, `inventory-${fixture.handle}`);
    const [a,b] = fixtures;
    expectStatus(await request('foreign-card', 'GET', `/v1/contact_card?handle=${encodeURIComponent(b.handle)}`, a.token), 403, 'foreign-card');
    await ownCard(b, 'foreign-card-preserved-target');

  } catch (error) {
    receipt.failures.push(error.message);
  } finally {
    // Only identities whose handles and one-time credentials came from THIS run.
    for (const fixture of fixtures) {
      if (fixture.deleteAttempted) continue;
      fixture.deleteAttempted = true;
      try {
        persist();
        const response = await request(`cleanup-${fixture.handle}`, 'DELETE', `/orgs/${organization.id}/agents/${encodeURIComponent(fixture.id)}`, organizationKey);
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
    'server-sha': { type: 'string' }, receipt: { type: 'string' }, 'private-state': { type: 'string' }, 'canonical-spec': { type: 'string' },
  } });
  let canonicalRules; let canonicalSpec;
  if (values['canonical-spec']) {
    const canonicalPath = resolve(values['canonical-spec']);
    const raw = readFileSync(canonicalPath);
    canonicalRules = canonicalRulesFromYaml(raw.toString('utf8'));
    canonicalSpec = { path: canonicalPath, sha256: createHash('sha256').update(raw).digest('hex') };
  }
  if (!values.execute) { console.log(JSON.stringify({ origin: STAGING_ORIGIN, requestsSent: 0, canonicalSpec, plan: PLAN }, null, 2)); return; }
  assert.ok(canonicalRules, "--canonical-spec must name main's supplied canonical file");
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
  const provenance = { harnessSha, harnessDirty, canonicalSpec, scriptSHA256: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
    platform: process.platform, arch: process.arch, node: process.version, sandbox: process.env.RELAY_DAYTONA_SANDBOX_ID, serverShaSource: 'deployment SHA supplied by main' };
  const result = await runOwnedSmoke({ provenance, canonicalRules, runId: values['run-id'], serverSha: values['server-sha'],
    organizationKey: (() => {
      const config = JSON.parse(readFileSync(process.env.RELAY_CONFIG_PATH, 'utf8'));
      assert.equal(config.console?.type, 'organization_key');
      assert.equal(config.console.console_api_url, STAGING_CONSOLE_API);
      return config.console.organization_key;
    })(),
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
