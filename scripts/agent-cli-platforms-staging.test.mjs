import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { STAGING_ORIGIN, runOwnedSmoke, canonicalRulesFromYaml } from './agent-cli-platforms-staging.mjs';
const serverSha = 'a'.repeat(40);
function fixtureServer({ uncertainSecond = false, cleanupConflict = false, permitForeignDelete = false, malformedCreate = false } = {}) {
  const calls = []; const identities = new Map(); let creates = 0;
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  return { calls, async fetchImpl(url, options) {
    assert.equal(url.origin, STAGING_ORIGIN);
    assert.equal(options.redirect, 'error');
    const token = options.headers.Authorization?.replace(/^Bearer /, '');
    calls.push({ method: options.method, path: url.pathname, token, body: options.body });
    if (options.method === 'POST') {
      assert.equal(url.pathname, '/v1/agents'); creates++;
      if (creates === 2 && uncertainSecond) throw Error('network failure');
      if (malformedCreate) return new Response('{"secret":"do-not-log-this-unparsed-response"', { status: 201 });
      const handle = `fixture_bird${creates}.dev`; const secret = `private-fixture-token-${creates}`;
      identities.set(secret, { handle, active: true });
      return json({ agent: { handle, kind: 'agent', is_active: true }, secret, share_url: `https://go.staging.relayapp.im/@${handle}` }, 201, { 'cache-control': 'no-store' });
    }
    const identity = identities.get(token);
    if (!identity?.active) return json({ error: 'unauthorized' }, 401);
    if (options.method === 'GET') {
      assert.equal(url.pathname, '/v1/contact_card');
      if (url.searchParams.has('handle') && url.searchParams.get('handle') !== identity.handle) return json({},403);
      return json({ contact_cards: [{ handle: identity.handle }] });
    }
    assert.equal(options.method, 'DELETE');
    const target = url.pathname.split('/').at(-1);
    if (target !== identity.handle) return permitForeignDelete ? new Response(null,{status:204}) : json({},403);
    if (cleanupConflict) return json({},409);
    identity.active = false;
    return new Response(null,{status:204});
  } };
}
async function proof(settings) {
  const server = fixtureServer(settings); const receipts = []; let privateState;
  const result = await runOwnedSmoke({ runId: 'fixture-unit', serverSha, fetchImpl: server.fetchImpl,
    saveReceipt: x => receipts.push(structuredClone(x)), savePrivate: x => { privateState = structuredClone(x); } });
  assert.ok(!JSON.stringify(receipts).includes('private-fixture-token'));
  return { ...server, result, privateState };
}
test('protocol fixture: two owned creates, local card inventory, isolation and revocation', async () => {
  const { result, calls } = await proof();
  assert.equal(result.result,'passed'); assert.equal(result.recoveryRequired,false);
  assert.equal(calls.filter(x=>x.method==='POST').length,2);
  assert.ok(calls.every(x=>!(x.method==='GET' && x.path==='/v1/agents')));
  assert.deepEqual(result.cleanup.map(x=>x.confirmed),[true,true]);
});
test('uncertain bootstrap is never retried and only the known fixture is cleaned', async () => {
  const { result, calls } = await proof({ uncertainSecond:true });
  assert.equal(result.result,'failed'); assert.equal(result.recoveryRequired,true);
  assert.equal(calls.filter(x=>x.method==='POST').length,2);
  assert.equal(calls.filter(x=>x.method==='DELETE').length,1);
  assert.equal(result.uncertainCreations.length,1);
});
test('409 cleanup stays red, retains private credentials, and never ACKs/retries', async () => {
  const { result, calls, privateState } = await proof({ cleanupConflict:true });
  assert.equal(result.result,'failed'); assert.equal(result.recoveryRequired,true);
  assert.ok(privateState.fixtures.every(x=>x.token && !x.deleted));
  assert.equal(calls.filter(x=>x.method==='DELETE').length,4); // unauthenticated attempt, foreign-token attempt, two owned cleanups
  assert.ok(calls.every(x=>!x.path.includes('ack')));
});
test('unexpected cross-agent deletion capability fails the isolation proof', async () => {
  const { result } = await proof({ permitForeignDelete:true });
  assert.equal(result.result,'failed');
  assert.match(result.failures.join(' '),/foreign-delete/);
});
test('malformed bootstrap body is never printed and is treated as uncertain', async () => {
  const { result, calls } = await proof({ malformedCreate:true });
  assert.equal(result.result,'failed'); assert.equal(result.recoveryRequired,true);
  assert.equal(calls.filter(x=>x.method==='POST').length,1);
  assert.ok(!JSON.stringify(result).includes('do-not-log-this-unparsed-response'));
});
test('default CLI is plan-only, and production-origin overrides are rejected', () => {
  const script = new URL('./agent-cli-platforms-staging.mjs', import.meta.url);
  const plan = spawnSync(process.execPath,[fileURLToPath(script)],{encoding:'utf8'});
  assert.equal(plan.status,0); assert.equal(JSON.parse(plan.stdout).requestsSent,0);
  const invalid = spawnSync(process.execPath,[fileURLToPath(script),'--origin','https://api.relayapp.im'],{encoding:'utf8'});
  assert.notEqual(invalid.status,0);
});

test('stale or missing canonical operations fail closed before execution', () => {
  assert.throws(() => canonicalRulesFromYaml('openapi: 3.1.0\npaths: {}\n'), /Canonical createAgent operation missing/);
});
