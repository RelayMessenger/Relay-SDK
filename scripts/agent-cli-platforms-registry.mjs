// Read-only staging registry acquisition; never publishes or substitutes a workspace dependency.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
export function publishedPlan(root, selection = process.env.RELAY_PLATFORM_PUBLISHED_PLAN) {
  // Ordinary source CI must never infer a pinned registry audit from file presence.
  if (selection === undefined || selection === null || selection === '') return undefined;
  assert.equal(typeof selection, 'string', 'Audit plan selection must be a path');
  const file = resolve(root, selection);
  assert.ok(existsSync(file), 'Explicit published audit plan was not found');
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  assert.match(plan.publishSha, /^[a-f0-9]{40}$/);
  assert.equal(plan.registry, 'https://registry.npmjs.org/');
  for (const key of ['cliVersion','sdkVersion']) assert.match(plan[key], /^\d+\.\d+\.\d+-staging\.\d+$/);
  assert.ok(['cli-sdk-only','full-runtime'].includes(plan.phase));
  if (plan.phase === 'full-runtime') assert.match(plan.openclawVersion, /^\d+\.\d+\.\d+-staging\.\d+$/);
  else assert.equal(plan.openclawVersion, undefined, 'CLI-only proof must not require plugin availability');
  assert.ok(typeof plan.inventoryPath === 'string' && existsSync(plan.inventoryPath));
  return plan;
}
export function packPublished(plan, scratch, npm, report) {
  const specs = [['cli','relaymessenger',plan.cliVersion],['sdk','@relaymessenger/sdk',plan.sdkVersion]];
  if (plan.phase === 'full-runtime') specs.push(['openclaw','@relaymessenger/openclaw-plugin',plan.openclawVersion]);
  report.publishedProofPhase = plan.phase;
  if (plan.phase === 'cli-sdk-only') report.openclawPublishedRuntime = 'not run: independent plugin publication/runtime phase';
  const packs = {}; const metadata = {};
  report.packageSource = 'actual published staging registry tarballs';
  report.publisherSourceSha = plan.publishSha;
  report.publisherRun = plan.publishRunId;
  report.registryPackages = [];
  for (const [key,name,version] of specs) {
    const tags = JSON.parse(npm(['view', name, 'dist-tags', '--json', '--registry', plan.registry]));
    if (!plan.frozenByOwner) assert.equal(tags.staging, version, `${name} staging tag is not the confirmed immutable version`);
    const meta = JSON.parse(npm(['view', `${name}@${version}`, '--json', '--registry', plan.registry]));
    assert.equal(meta.name,name); assert.equal(meta.version,version);
    if (meta.gitHead !== undefined) assert.equal(meta.gitHead,plan.publishSha,`${name}: registry gitHead differs from the confirmed publisher source`);
    assert.ok(typeof meta.dist?.integrity === 'string' && meta.dist.integrity.startsWith('sha512-'));
    const packed = JSON.parse(npm(['pack', `${name}@${version}`, '--ignore-scripts', '--json', '--registry', plan.registry, '--pack-destination', scratch]));
    assert.equal(packed.length,1);
    const path = join(scratch,packed[0].filename); const bytes=readFileSync(path);
    const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
    assert.equal(integrity,meta.dist.integrity,'Registry tarball integrity mismatch');
    packs[key]=path;metadata[key]=meta;
    report.registryPackages.push({name,version,stagingTag:tags.staging,latestObserved:tags.latest??null,tarballURL:meta.dist.tarball,integrity,downloadSHA256:createHash('sha256').update(bytes).digest('hex'),registryGitHead:meta.gitHead??null,publishTime:meta.time?.[version]??null});
  }
  return { packs, metadata };
}
function fileHashes(root) {
  const files={};
  const walk=dir=>{for(const item of readdirSync(dir,{withFileTypes:true})){
    if(item.name==='node_modules')continue;
    const file=join(dir,item.name);
    if(item.isDirectory())walk(file);
    else if(item.isFile())files['package/'+relative(root,file).replaceAll('\\','/')]=createHash('sha256').update(readFileSync(file)).digest('hex');
    else throw Error('Unexpected linked package file');
  }};walk(root);return files;
}
export function compareInstalledPackage(candidate, installedManifest, hashes) {
  assert.equal(installedManifest.name,candidate.name);
  const expected={...candidate.files};const actual={...hashes};
  delete expected['package/package.json'];delete actual['package/package.json'];
  assert.deepEqual(actual,expected,`${candidate.name}: non-manifest published bytes differ from tested candidate`);
  const a=structuredClone(candidate.manifest),b=structuredClone(installedManifest);
  const manifestChanges={candidateVersion:a.version,publishedVersion:b.version};
  delete a.version;delete b.version;
  if(a.dependencies?.['@relaymessenger/sdk']!==undefined){manifestChanges.candidateSdkDependency=a.dependencies['@relaymessenger/sdk'];manifestChanges.publishedSdkDependency=b.dependencies?.['@relaymessenger/sdk'];delete a.dependencies['@relaymessenger/sdk'];delete b.dependencies['@relaymessenger/sdk'];}
  assert.deepEqual(b,a,`${candidate.name}: unexpected package manifest change beyond release version/dependency pin`);
  return manifestChanges;
}
export function verifyPublishedConsumer(root, consumer, plan, report) {
  const cliRoot=join(consumer,'node_modules','relaymessenger');
  const require=createRequire(join(cliRoot,'package.json'));
  const sdkManifestPath=require.resolve('@relaymessenger/sdk/package.json');
  const sdkRoot=sdkManifestPath.slice(0,-'/package.json'.length);
  const cliManifest=JSON.parse(readFileSync(join(cliRoot,'package.json')));
  const sdkManifest=JSON.parse(readFileSync(sdkManifestPath));
  assert.equal(cliManifest.version,plan.cliVersion);assert.equal(sdkManifest.version,plan.sdkVersion);
  assert.equal(cliManifest.dependencies['@relaymessenger/sdk'],plan.sdkVersion,'Published CLI dependency must naturally select confirmed fresh SDK');
  assert.ok(!existsSync(join(consumer,'node_modules','@relaymessenger','cli')),'Retired scoped wrapper must not be installed');
  const inventory=JSON.parse(readFileSync(plan.inventoryPath,'utf8'));
  assert.match(inventory.candidateSha,/^[a-f0-9]{40}$/,'Reviewed candidate inventory must identify its source');
  assert.equal(inventory.dirty,'');
  report.candidateComparison=[];
  for(const [name,dir,manifest] of [['relaymessenger',cliRoot,cliManifest],['@relaymessenger/sdk',sdkRoot,sdkManifest]]){
    const candidate=inventory.packages.find(x=>x.name===name);assert.ok(candidate);
    const changes=compareInstalledPackage(candidate,manifest,fileHashes(dir));
    report.candidateComparison.push({name,version:manifest.version,candidateSha:inventory.candidateSha,nonManifestBytesIdentical:true,manifestChanges:changes});
  }
  report.dependencyProof={forcedWorkspaceSDK:false,cliVersion:cliManifest.version,declaredSdk:cliManifest.dependencies['@relaymessenger/sdk'],actuallyResolvedSdkVersion:sdkManifest.version};
  return cliManifest;
}
