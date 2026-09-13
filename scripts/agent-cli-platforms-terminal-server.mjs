import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire((process.env.RELAY_TERMINAL_SOURCE ?? '/home/daytona/terminal-session') + '/package.json');
const { WebSocketServer } = require('ws');
const [readyPath, receiptPath] = process.argv.slice(2);
const token = 'rly_live_' + 'P'.repeat(43); const handle = 'my_agent.terminal';
const card = { handle, first_name: 'Terminal Fixture', last_name: null, image_url: 'https://api.staging.relayapp.im/assets/fixture.png', is_active: true, kind: 'agent' };
const report = { scope: 'real installed CLI + loopback HTTP/WS, not live Server', creates: 0, consoleCreates: 0, contactCards: 0, observers: 0, eventsSent: 0, frames: [], queries: [], authConfirmed: true, requestPaths: [] };
const save = () => writeFileSync(receiptPath, JSON.stringify(report));
let devicePolls = 0;
const server = createServer((req, res) => {
 report.requestPaths.push(`${req.method} ${req.url}`);res.setHeader('content-type', 'application/json');
 if (req.method === 'POST' && req.url === '/auth/cli/device') {res.end(JSON.stringify({device_code:'terminal-device',user_code:'TERM-CODE',verification_uri:'http://127.0.0.1/device',expires_in:60,interval:1,client_id:'terminal-client'}));}
 else if (req.method === 'POST' && req.url === '/auth/cli/device-code') {devicePolls++; if (devicePolls === 1) {res.writeHead(400);res.end(JSON.stringify({error:'authorization_pending'}));} else res.end(JSON.stringify({access_token:'terminal-console-access',refresh_token:'terminal-console-refresh',organization_id:'org_terminal',user:{id:'user_terminal',email:'terminal@example.com',name:'Terminal Fixture'}}));}
 else if (req.method === 'POST' && req.url === '/auth/cli/bootstrap') {res.writeHead(200);res.end(JSON.stringify({organization_id:'org_terminal',created:false}));}
 else if (req.method === 'GET' && req.url === '/me') {res.end(JSON.stringify({org:{id:'org_terminal',handleNamespace:'terminal'}}));}
 else if (req.method === 'POST' && req.url === '/orgs/org_terminal/agents') {report.consoleCreates++;res.writeHead(201);res.end(JSON.stringify({agent:{handle,first_name:'Terminal Fixture',image_url:card.image_url},token}));}
 else if (req.method === 'POST' && req.url === '/v1/agents') {report.creates++;res.writeHead(201);res.end(JSON.stringify({agent:card,secret:token,share_url:`https://staging.relayapp.im/@${handle}`}));}
 else if (req.method === 'GET' && req.url === '/v1/contact_card') {report.contactCards++;report.authConfirmed &&= req.headers.authorization===`Bearer ${token}`;res.end(JSON.stringify({contact_cards:[card]}));}
 else {res.writeHead(404);res.end('{}');}save();
});
const wss=new WebSocketServer({server});const timers=[];
wss.on('connection',(socket,req)=>{
 report.observers++;report.queries.push(req.url);report.authConfirmed &&= req.headers.authorization===`Bearer ${token}`;
 socket.on('message',raw=>{report.frames.push(JSON.parse(raw.toString()));save();});
 socket.send(JSON.stringify({type:'ready',observational:true,connection_id:'01993d50-ef7b-7b37-886b-23fd80c7ec10',acked_through:'0',full_sync_required:false,full_sync_through:null,heartbeat_interval_ms:30000,max_in_flight:2}));
 // Two incoming messages, then the agent's own first reply: connect's reply wait
// ends on a `message.sent` from the agent's handle (packages/cli/src/connect.ts, waitForFirstReply).
let sequence=0;const timer=setInterval(()=>{if(socket.readyState!==1)return;report.eventsSent++;const reply=sequence>=2;socket.send(JSON.stringify({type:'event',sequence:String(++sequence),event:{api_version:'v1',webhook_version:'2026-08-30',event_type:reply?'message.sent':'message.received',event_id:'01993d50-ef7b-7b37-886b-23fd80c7ec11',created_at:new Date().toISOString(),trace_id:'owned-installed-pty',agent_id:'01993d50-d2a8-7fe2-8b76-9eaf04816377',data:{...(reply?{sender_handle:{handle}}:{}),parts:[{type:'text',value:reply?`owned integrated agent reply ${sequence}`:`owned integrated observer event ${sequence}`}]}}}));save();},250);timers.push(timer);socket.on('close',()=>clearInterval(timer));save();
});
server.listen(0,'127.0.0.1',()=>{writeFileSync(readyPath,JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`}));save();});
function stop(){for(const timer of timers)clearInterval(timer);for(const socket of wss.clients)socket.terminate();wss.close(()=>server.close(()=>{save();process.exit(0);}));}
process.on('SIGTERM',stop);setTimeout(stop,90000).unref();
