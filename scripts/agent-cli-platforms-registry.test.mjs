import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareInstalledPackage, publishedPlan } from './agent-cli-platforms-registry.mjs';
const candidate={name:'relaymessenger',manifest:{name:'relaymessenger',version:'0.1.0-staging.0',bin:{relaymessenger:'./dist/cli.js'},dependencies:{'@relaymessenger/sdk':'0.3.1-staging.0',commander:'^15.0.0'}},files:{'package/package.json':'old-manifest','package/dist/cli.js':'same-code','package/README.md':'same-docs'}};
const published=()=>({...structuredClone(candidate.manifest),version:'0.1.1-staging.0',dependencies:{'@relaymessenger/sdk':'0.3.2-staging.0',commander:'^15.0.0'}});
const files=()=>({...candidate.files,'package/package.json':'new-manifest'});
test('only expected immutable release version and SDK dependency pins may differ',()=>{
 const result=compareInstalledPackage(candidate,published(),files());assert.equal(result.publishedVersion,'0.1.1-staging.0');assert.equal(result.publishedSdkDependency,'0.3.2-staging.0');
});
test('unexpected shipped executable drift fails comparison',()=>{const f=files();f['package/dist/cli.js']='different';assert.throws(()=>compareInstalledPackage(candidate,published(),f),/published bytes differ/);});
test('missing and extra shipped files fail comparison',()=>{const f=files();delete f['package/README.md'];assert.throws(()=>compareInstalledPackage(candidate,published(),f));const g=files();g['package/unreviewed.js']='extra';assert.throws(()=>compareInstalledPackage(candidate,published(),g));});
test('wrapper or executable changes fail comparison',()=>{const p=published();p.bin.relaymessenger='./wrapper.js';assert.throws(()=>compareInstalledPackage(candidate,p,files()),/unexpected package manifest change/);});
test('unrelated dependency changes fail comparison',()=>{const p=published();p.dependencies.commander='^16.0.0';assert.throws(()=>compareInstalledPackage(candidate,p,files()),/unexpected package manifest change/);});

test('CLI/SDK-only plan is independent of plugin registry availability',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-published-plan-'));mkdirSync(join(root,'scripts'));
  const path=join(root,'scripts/agent-cli-platforms-published.json');
  const plan={phase:'cli-sdk-only',registry:'https://registry.npmjs.org/',cliVersion:'0.1.0-staging.0',sdkVersion:'0.3.1-staging.1',publishSha:'a'.repeat(40),inventoryPath:path};
  try { writeFileSync(path,JSON.stringify(plan));assert.equal(publishedPlan(root,path).openclawVersion,undefined);
    writeFileSync(path,JSON.stringify({...plan,phase:'full-runtime'}));assert.throws(()=>publishedPlan(root,path));
    writeFileSync(path,JSON.stringify({...plan,cliVersion:'latest'}));assert.throws(()=>publishedPlan(root,path));
    writeFileSync(path,JSON.stringify({...plan,registry:'https://elsewhere.invalid/'}));assert.throws(()=>publishedPlan(root,path));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('ordinary source mode ignores even a present stale autoactivating filename',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-source-default-'));mkdirSync(join(root,'scripts'));
  const path=join(root,'scripts/agent-cli-platforms-published.json');
  try { writeFileSync(path,'not even valid JSON: stale plan must not be read');
    assert.equal(publishedPlan(root,null),undefined);
    assert.equal(publishedPlan(root,''),undefined);
    assert.throws(()=>publishedPlan(root,path));
    assert.throws(()=>publishedPlan(root,join(root,'missing-explicit-audit.json')),/Explicit published audit plan was not found/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
