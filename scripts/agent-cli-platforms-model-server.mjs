// Local deterministic model only. No Relay API routes and no external network calls.
import http from 'node:http';
const port = Number(process.env.MOCK_RELAY_PORT);
const expected = process.env.RELAY_FIXTURE_REQUEST;
const reply = process.env.RELAY_FIXTURE_REPLY;
if (!port || !expected || !reply) throw Error('Explicit model fixture inputs are required');
let matched = 0;
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
  let raw = ''; for await (const chunk of request) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch { response.writeHead(400); response.end(); return; }
  const match = JSON.stringify(body.messages ?? []).includes(expected);
  const content = match ? reply : 'Ready for the staging connection check.';
  if (match) console.log(`[model-fixture] matched phone request count=${++matched}`);
  else console.log('[model-fixture] non-request context turn');
  if (body.stream) {
    response.writeHead(200, {'content-type':'text/event-stream'});
    for (const choice of [
      { index:0,delta:{role:'assistant',content},finish_reason:null },
      { index:0,delta:{},finish_reason:'stop' },
    ]) response.write(`data: ${JSON.stringify({id:'verification-model',object:'chat.completion.chunk',created:0,model:body.model,choices:[choice]})}\n\n`);
    response.end('data: [DONE]\n\n');
  } else {
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({id:'verification-model',object:'chat.completion',created:0,model:body.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }
});
server.listen(port,'127.0.0.1',()=>console.log(`[model-fixture] listening on http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
