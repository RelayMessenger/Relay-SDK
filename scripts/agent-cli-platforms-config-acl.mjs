// Inspect the actual installed CLI auth config, then a deliberately insecure test copy.
import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const [consumer, configPath, scratch] = process.argv.slice(2);
const installed = join(consumer, 'node_modules/relaymessenger/dist');
const { inspectConfigPermissions } = await import(pathToFileURL(join(installed,'config.js')));
const context = path => ({ env: { RELAY_CONFIG_PATH: path } });
const privateResult = await inspectConfigPermissions(context(configPath));
assert.equal(privateResult.exists, true); assert.equal(privateResult.secure, true);
const broad = join(scratch, 'intentionally-broad-synthetic-config.json');
await writeFile(broad, await readFile(configPath), { mode: 0o600 });
let evidence;
if (process.platform === 'win32') {
  const { inspectWindowsAcl } = await import(pathToFileURL(join(installed,'runtime-connect/windows-acl.js')));
  const acl = await inspectWindowsAcl(configPath);
  const trusted = new Set([acl.user, 'S-1-5-18', 'S-1-5-32-544']);
  const sensitiveRights = 1 | 2 | 4 | 8 | 16 | 64 | 256 | 65536 | 262144 | 524288 | 0x80000000 | 0x40000000;
  assert.ok(trusted.has(acl.owner));
  assert.ok(acl.rules.every(rule => rule.type === 'Deny' || trusted.has(rule.sid) || !(rule.rights & sensitiveRights)), 'Native auth config grants sensitive rights to an untrusted principal');
  execFileSync('icacls.exe', [broad, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' });
  const broadAcl = await inspectWindowsAcl(broad);
  assert.ok(broadAcl.rules.some(rule => rule.sid === 'S-1-1-0' && rule.type === 'Allow' && (rule.rights & 1)), 'Broad fixture was not actually broadened');
  evidence = { nativeAcl: true, ownerTrusted: true, untrustedSensitiveGrant: false, broadEveryoneReadObserved: true };
} else {
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await chmod(broad, 0o644);
  evidence = { nativeMode: '0600', broadFixtureMode: '0644' };
}
const broadResult = await inspectConfigPermissions(context(broad));
assert.equal(broadResult.secure, false, 'Installed auth config inspector must reject the actual broad fixture');
console.log(JSON.stringify({ platform: process.platform, ...evidence, privateConfigAccepted: true, broadConfigRejected: true }));
