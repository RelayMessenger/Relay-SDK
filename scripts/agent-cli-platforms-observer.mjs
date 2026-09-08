// Actual installed SDK + real loopback WebSocket; no deployed Server claim.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
const consumer = process.argv[2];
const require = createRequire(join(consumer, 'package.json'));
const { default: Relay } = await import(pathToFileURL(require.resolve('@relaymessenger/sdk')).href);
const ready = { type: 'ready', connection_id: '01993d50-ef7b-7b37-886b-23fd80c7ec10', acked_through: '0', full_sync_required: false, full_sync_through: null, heartbeat_interval_ms: 30000, max_in_flight: 2 };
const event = sequence => ({ type: 'event', sequence, event: { api_version: 'v1', webhook_version: '2026-08-30', event_type: 'message.received', event_id: '01993d50-ef7b-7b37-886b-23fd80c7ec11', created_at: '2026-09-08T00:00:00Z', trace_id: 'native-installed-observer', agent_id: '01993d50-d2a8-7fe2-8b76-9eaf04816377', data: {} } });
const cases = [];
for (const mode of ['confirmed', 'reconnect', 'missing-marker', 'false-marker', 'full-sync']) {
  const server = createServer(); const wss = new WebSocketServer({ server });
  const frames = []; const sequences = []; let connections = 0; let fullSync = 0; let queryConfirmed = false; let authConfirmed = false;
  wss.on('connection', (socket, request) => {
    connections++; queryConfirmed = request.url === '/v1/websocket?observe=true'; authConfirmed = request.headers.authorization === 'Bearer owned-offline-observer';
    const connection = connections;
    socket.on('message', raw => {
      frames.push(JSON.parse(raw.toString()));
      if (mode === 'reconnect' && connection === 1) socket.close(1012, 'owned restart');
    });
    socket.send(JSON.stringify({ ...ready, ...(mode === 'missing-marker' ? {} : { observational: mode !== 'false-marker' }), ...(mode === 'full-sync' ? { full_sync_required: true, full_sync_through: '8' } : {}) }));
    for (const sequence of ['1', '2', '5']) socket.send(JSON.stringify(event(sequence)));
    socket.send(JSON.stringify({ type: 'ping', sent_at: '2026-09-08T00:00:00Z' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const control = new AbortController(); let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; control.abort(); }, 5000);
  const gaps = []; let error;
  const run = new Relay({ apiKey: 'owned-offline-observer', baseURL: `http://127.0.0.1:${server.address().port}` }).websocket.run({
    observe: true, signal: control.signal, minReconnectDelayMs: 10, maxReconnectDelayMs: 10,
    onEvent: async (_event, context) => sequences.push(context.sequence),
    onFullSync: async () => { fullSync++; }, onObservationGap: gap => gaps.push(gap),
  }).catch(value => { error = value; });
  try {
    if (mode === 'confirmed' || mode === 'reconnect') {
      const end = Date.now() + 4000;
      while (frames.length < (mode === 'reconnect' ? 2 : 1) && !error && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      control.abort(); await run;
      assert.equal(error, undefined);
      assert.deepEqual(sequences, mode === 'reconnect' ? ['1', '2', '5', '1', '2', '5'] : ['1', '2', '5']);
      const gap = { expectedSequence: '3', receivedSequence: '5' };
      assert.deepEqual(gaps, mode === 'reconnect' ? [gap, gap] : [gap]);
      assert.deepEqual(frames, mode === 'reconnect' ? [{ type: 'pong' }, { type: 'pong' }] : [{ type: 'pong' }]);
    } else {
      await run; assert.ok(error, 'Unsupported observer must fail closed');
      assert.deepEqual(sequences, []); assert.deepEqual(frames, []);
    }
    assert.equal(timedOut, false); assert.equal(connections, mode === 'reconnect' ? 2 : 1); assert.equal(fullSync, 0);
    assert.equal(queryConfirmed, true); assert.equal(authConfirmed, true);
    cases.push({ mode, passed: true, connections, sequences, frames, fullSync, queryConfirmed, authConfirmed });
  } finally {
    clearTimeout(deadline); control.abort(); await run;
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
}
console.log(JSON.stringify({ result: 'passed', platform: process.platform, scope: 'actual installed SDK loopback observer; not live Server', cases }));
