// Installed CLI/SDK image regression derived from src/local-image-flow.test.ts.
// The injected fetch never reaches a network endpoint.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [consumer, scratch] = process.argv.slice(2);
const { runCLI } = await import(pathToFileURL(join(consumer, 'node_modules/relaymessenger/dist/program.js')));
const home = join(scratch, 'installed-image');
await mkdir(home, { mode: 0o700 });
if (process.platform === 'win32') {
  const { protectWindowsPath } = await import(pathToFileURL(join(consumer, 'node_modules/relaymessenger/dist/runtime-connect/windows-acl.js')));
  await protectWindowsPath(home, true);
}
const secret = `rly_live_${'I'.repeat(43)}`;
const base = 'https://api.staging.relayapp.im';
const handle = 'installed_image.dev';
const attachment = '019a2123-1234-7890-abcd-123456789abc';
const card = { handle, first_name: 'Installed Image', last_name: null, image_url: `${base}/assets/default.png`, is_active: true, kind: 'agent' };
const promoted = { ...card, image_url: `${base}/images/copied.png` };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr4sAAAAASUVORK5CYII=', 'base64');
const image = join(home, 'picture.png');
await writeFile(image, png);
const config = join(home, 'config.json');
const calls = []; const output = [];
const deps = {
  configContext: { home, env: { RELAY_CONFIG_PATH: config, RELAY_API_URL: base, RELAY_AGENT_TOKEN: 'unrelated-env-identity' } },
  isInteractive: false, stdout: text => output.push(text), stderr: text => output.push(text),
  fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, base);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'POST' && url.pathname === '/v1/agents') {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.equal(body.image_url, undefined);
      return Response.json({ agent: card, secret, share_url: `https://staging.relayapp.im/@${handle}` }, { status: 201 });
    }
    if (method !== 'PUT') assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
    if (method === 'GET' && url.pathname === '/v1/contact_card') return Response.json({ contact_cards: [card] });
    if (method === 'POST' && url.pathname === '/v1/attachments') {
      assert.equal(JSON.parse(await readFile(config)).profiles[handle].agent_token, secret);
      assert.deepEqual(body, { filename: 'picture.png', content_type: 'image/png', size_bytes: png.length });
      return Response.json({ attachment_id: attachment, upload_url: `${base}/fixture/upload`, download_url: `${base}/fixture/download`, http_method: 'PUT', expires_at: '2099-09-09T00:00:00Z', required_headers: { 'content-type': 'image/png' } }, { status: 201 });
    }
    if (method === 'PUT' && url.pathname === '/fixture/upload') {
      assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), png);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === `/v1/attachments/${attachment}`) return Response.json({ id: attachment, status: 'complete' });
    if (method === 'PATCH' && url.pathname === '/v1/contact_card') {
      assert.equal(url.searchParams.get('handle'), handle);
      assert.deepEqual(body, { attachment_id: attachment });
      return Response.json(promoted);
    }
    throw Error('Unexpected injected fixture request');
  },
};
assert.equal(await runCLI(['agents', 'create', '--image', image, '--json'], deps), 0);
assert.deepEqual(calls, ['POST /v1/agents', 'GET /v1/contact_card', 'POST /v1/attachments', 'PUT /fixture/upload', `GET /v1/attachments/${attachment}`, 'PATCH /v1/contact_card']);
assert.equal(JSON.parse(output[0]).image_url, promoted.image_url);
assert.equal(JSON.parse(output[0]).image.status, 'updated');
assert.ok(!output.join('').includes(secret) && !output.join('').includes('unrelated-env-identity'));
console.log(JSON.stringify({ result: 'passed', installed: true, scope: 'injected HTTP fixture only', calls, persistedBeforeUpload: true, exactImageBytes: true, noTokenEcho: true }));
