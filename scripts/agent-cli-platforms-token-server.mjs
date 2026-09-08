// Controlled native HTTP fixture for token import. Never reaches a Relay service.
import { createServer } from 'node:http';
import { writeFileSync, renameSync } from 'node:fs';
const [readyFile, logFile] = process.argv.slice(2);
if (!readyFile || !logFile) throw Error('Private fixture ready/log paths are required');
const token = `rly_live_${'V'.repeat(43)}`; // Deliberately synthetic, accepted only by this process.
const requests = [];
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const accepted = request.headers.authorization === `Bearer ${token}`;
  const status = !accepted ? 401 : request.method === 'GET' && path === '/v1/contact_card' ? 200 : 404;
  requests.push({ method: request.method, path, status, credentialAccepted: accepted });
  writeFileSync(logFile, JSON.stringify(requests));
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(status === 200 ? { contact_cards: [{
    handle: 'verification_bird.dev', first_name: 'Verification Bird', last_name: null,
    image_url: null, kind: 'agent', is_active: true,
  }] } : { error: { message: 'Fixture credential or route rejected', code: 2004 } }));
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(`${readyFile}.tmp`, JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}` }));
  renameSync(`${readyFile}.tmp`, readyFile);
});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
  server.closeAllConnections(); server.close(() => process.exit(0));
});
