import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire((process.env.RELAY_TERMINAL_SOURCE ?? '/home/daytona/terminal-session') + '/package.json');
const { WebSocketServer } = require('ws');
const [readyPath, receiptPath] = process.argv.slice(2);
const token = 'rel_token_' + 'P'.repeat(43); const handle = 'my_agent.terminal';
const card = { handle, first_name: 'Terminal Fixture', last_name: null, image_url: 'https://api.staging.relayapp.im/assets/fixture.png', is_active: true, kind: 'agent' };
const report = { scope: 'real installed CLI + loopback HTTP/WS, not live Server', creates: 0, consoleCreates: 0, contactCards: 0, observers: 0, eventsSent: 0, frames: [], queries: [], authConfirmed: true, requestPaths: [] };
const save = () => writeFileSync(receiptPath, JSON.stringify(report));
let devicePolls = 0;
const server = createServer((req, res) => {
 report.requestPaths.push(`${req.method} ${req.url}`);res.setHeader('content-type', 'application/json');
 // Relay-Auth's device grant, the three calls packages/cli/src/console-auth.ts makes
 // (postDeviceStart, pollDevice, fetchSession); RELAY_AUTH_URL points the CLI here.
 if (req.method === 'POST' && req.url === '/api/auth/device/code') {res.end(JSON.stringify({device_code:'terminal-device',user_code:'TERM-CODE',verification_uri:'http://127.0.0.1/device',verification_uri_complete:'http://127.0.0.1/device?user_code=TERM-CODE',expires_in:60,interval:1}));}
 else if (req.method === 'POST' && req.url === '/api/auth/device/token') {devicePolls++; if (devicePolls === 1) {res.writeHead(400);res.end(JSON.stringify({error:'authorization_pending'}));} else res.end(JSON.stringify({access_token:'terminal-console-access',token_type:'Bearer'}));}
 else if (req.method === 'GET' && req.url === '/api/auth/get-session') {report.authSessionRead = req.headers.authorization==='Bearer terminal-console-access';res.end(JSON.stringify({user:{id:'user_terminal',email:'terminal@example.com',name:'Terminal Fixture'},session:{expiresAt:new Date(Date.now()+30*24*3600*1000).toISOString()}}));}
 // Relay Console GET /me (apps/api/src/routes/me.ts): names the first organization itself for a person's bearer.
 else if (req.method === 'GET' && req.url === '/me') {report.meBearer=req.headers.authorization;res.end(JSON.stringify({user:{id:'user_terminal',email:'terminal@relayapp.im',name:'Terminal Person'},org:{id:'org_terminal',name:'Terminal Person',logoUrl:null},orgs:[{id:'org_terminal',name:'Terminal Person',logoUrl:null,role:'owner'}],role:'owner',capabilities:[]}));}
 else if (req.method === 'POST' && req.url === '/orgs/org_terminal/agents') {report.consoleCreates++;res.writeHead(201);res.end(JSON.stringify({agent:{handle,displayName:'Terminal Fixture',avatarUrl:card.image_url},token}));}
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
