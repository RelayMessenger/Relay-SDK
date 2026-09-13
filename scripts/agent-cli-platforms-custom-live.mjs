// One explicitly authorized live custom identity plus one deliberate 409 attempt. Never retry creation.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'https://api.staging.relayapp.im';
const inputImage = `${api}/assets/relay-agent-default-4b3e4b9358f35c66.png`;
const serverSha = 'e54a48128d29f42b56344218edcac023cf5eb5d0';
const canonicalHash = '7d46b16f5dc19034cbdcb45bdd79816a9a2f4c9f6febb8520db0517dfe9eae64';
if (process.platform !== 'linux' || !process.env.RELAY_DAYTONA_SANDBOX_ID || process.env.RELAY_CUSTOM_LIVE_CONFIRMED !== serverSha) throw Error('Explicit confirmed staging deployment in owned Daytona is required');
const canonicalFile = process.env.RELAY_CUSTOM_CANONICAL_SPEC;
assert.ok(canonicalFile);assert.equal(createHash('sha256').update(readFileSync(canonicalFile)).digest('hex'),canonicalHash);
const receiptPath = resolve(process.env.RELAY_CUSTOM_RECEIPT);
mkdirSync(dirname(receiptPath),{recursive:true});
const temp = mkdtempSync(join(tmpdir(),'relay-custom-live-'));
const config = join(temp,'private-cli-config.json');
const recipe = join(temp,'recipe.json');writeFileSync(recipe,JSON.stringify({recipe:{image:{}}}),{mode:0o600});
const runId = '20260908064002697'; // Explicit same-handle reattempt after definitive422 and main-confirmed deployment fix.
assert.equal(process.env.RELAY_CUSTOM_PREVIOUS_OUTCOME, 'definitive-422-no-identity');
const handle = `verify_${runId}.dev`;const name = `Verification Custom ${runId}`;
const manifest = JSON.parse(readFileSync(join(root,'packages/cli/package.json')));assert.equal(manifest.name,'relaymessenger');
const env={...process.env,RELAY_CONFIG_PATH:config,RELAY_API_URL:api};delete env.RELAY_AGENT_TOKEN;delete env.RELAY_PROFILE;
let secret;let owned=false;let deletionAttempted=false;
const report={serverSha,canonicalHash,runId,handle,name,platform:process.platform,node:process.version,sandbox:process.env.RELAY_DAYTONA_SANDBOX_ID,commands:[],createCommandsInvoked:0,privateConfig:config,recipeAccepted:false};
const redact=x=>String(x).replace(/(?:rel|rly)_live_[A-Za-z0-9]{43}/g,'[REDACTED]');
const save=()=>writeFileSync(receiptPath,redact(JSON.stringify(report,null,2)));
function run(command,args,options={}) {
 const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,...options});
 const output=`${result.stdout??''}${result.stderr??''}`;
 report.commands.push({command:[command,...args],cwd:options.cwd??root,exit:result.status,output:redact(output)});save();
 assert.equal(result.status,options.expectedExit??0,'Command failed; inspect redacted receipt');return result.stdout??'';
}
async function card(label) {
 const response=await fetch(`${api}/v1/contact_card`,{headers:{authorization:`Bearer ${secret}`},redirect:'error',signal:AbortSignal.timeout(15000)});
 report[label]={status:response.status};save();return {response,body:response.status===200?await response.json():null};
}
let shim;
try {
 report.sha=run('git',['rev-parse','HEAD']).trim();report.dirty=run('git',['status','--porcelain']).trim();
 const pack=join(temp,'packs');const consumer=join(temp,'consumer');mkdirSync(pack);mkdirSync(consumer);writeFileSync(join(consumer,'package.json'),'{"private":true}');
 const files=[];
 for(const pkg of ['@relaymessenger/sdk','relaymessenger']) {const result=JSON.parse(run('npm',['pack','--workspace',pkg,'--ignore-scripts','--json','--pack-destination',pack]));files.push(join(pack,result[0].filename));}
 report.tarballs=files.map(file=>({file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}));
 run('npm',['install','--ignore-scripts','--no-audit','--no-fund',...files],{cwd:consumer});
 shim=join(consumer,'node_modules/.bin/relaymessenger');
 const args=['agents','create','--api-url',api,'--handle',handle,'--name',name,'--image-url',inputImage,'--image-recipe',recipe,'--token-name',`verification-custom-${runId}`,'--json'];
 report.createCommandsInvoked++;
 const created=JSON.parse(run(shim,args,{cwd:consumer}));
 const stored=JSON.parse(readFileSync(config));secret=stored.profiles[created.profile]?.agent_token;
 assert.ok(typeof secret==='string' && /^(?:rel|rly)_live_[A-Za-z0-9]{43}$/.test(secret));owned=true;
 assert.equal(created.handle,handle);assert.equal(created.display_name,name);assert.equal(created.token,'stored');assert.equal(created.agent,undefined);assert.equal(created.share_url,`https://go.staging.relayapp.im/@${handle}`);
 const permanent=new URL(created.image_url);assert.equal(permanent.href,inputImage,'Exact trusted immutable bundled asset must be retained without remote ingestion');assert.equal(permanent.search,'');assert.equal(permanent.username,'');assert.equal(permanent.password,'');
 report.created={profile:created.profile,handle,name,shareUrl:created.share_url,imageUrl:permanent.href};report.recipeAccepted=true;save();
 const first=await card('cardBeforeDuplicate');assert.equal(first.response.status,200);const ownCard=first.body.contact_cards.find(x=>x.handle===handle);assert.equal(ownCard.first_name,name);assert.equal(ownCard.image_url,permanent.href);
 const image=await fetch(permanent,{redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(image.status,200);assert.ok((image.headers.get('content-type')??'').startsWith('image/'));const bytes=Buffer.from(await image.arrayBuffer());assert.ok(bytes.length>0);report.permanentImage={status:image.status,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const before=readFileSync(config,'utf8');const duplicate=[...args];duplicate[duplicate.indexOf('--name')+1]='Must Not Replace';report.createCommandsInvoked++;
 run(shim,duplicate,{cwd:consumer,expectedExit:1});assert.match(report.commands.at(-1).output,/HTTP 409\b/);assert.equal(readFileSync(config,'utf8'),before);
 const after=await card('cardAfterDuplicate');assert.equal(after.response.status,200);assert.deepEqual(after.body,first.body);report.duplicate={http409:true,privateIdentityUnchanged:true,serverCardUnchanged:true};
 report.result='passed';
} catch(error) {report.result='failed';report.failure=redact(error.message);process.exitCode=1;}
finally {
 if(owned && !deletionAttempted) {
  deletionAttempted=true;
  try {
   run(shim,['--profile',handle,'agents','delete',handle,'--json']);
   const revoked=await card('revokedToken');assert.equal(revoked.response.status,401);report.cleanup={deleted:true,revoked:true};
  } catch(error) {report.result='failed';report.cleanup={deleted:false,confirmed:false,error:redact(error.message)};process.exitCode=1;}
 }
 report.definitivelyRejectedBeforeIdentity = !owned && report.commands.some(c => /Agent creation was rejected\. HTTP 4\d\d/.test(c.output));
 report.recoveryRequired = owned ? !report.cleanup?.revoked : !report.definitivelyRejectedBeforeIdentity;
 // Retain private candidate directory for scoped recovery/review; it is never downloaded as an artifact.
 save();console.log(JSON.stringify({result:report.result,handle,createCommandsInvoked:report.createCommandsInvoked,cleanup:report.cleanup,receipt:receiptPath}));
}
