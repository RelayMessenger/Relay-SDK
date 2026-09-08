#!/usr/bin/env node
// Mac-side transfer/execution control only. All builds/tests execute in Daytona.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, sandbox: { type: 'string' },
  'upload-local': { type: 'string' }, 'upload-remote': { type: 'string' },
  'download-remote': { type: 'string' }, 'download-local': { type: 'string' },
  'exec-file': { type: 'string' }, cwd: { type: 'string' }, receipt: { type: 'string' },
  'secret-env': { type: 'string' }, 'secret-path': { type: 'string' },
  'secret-name': { type: 'string', multiple: true },
} });
for (const required of ['workspace', 'sandbox', 'receipt']) {
  if (!values[required]) throw Error(`--${required} is required`);
}
if (process.platform === 'linux') throw Error('This transfer controller is for the Mac host, not a Linux build runner.');
if (values['secret-env'] && !['dev', 'staging'].includes(values['secret-env'])) throw Error('Relay test secrets must be dev or staging, never production.');
const workspace = resolve(values.workspace);
const receipt = resolve(values.receipt);
mkdirSync(dirname(receipt), { recursive: true });
const sensitive = [];
function secrets(environment, folder) {
  const output = execFileSync(resolve(workspace, '_runtime/bin/infisical'), [
    'secrets', '--projectId', 'f922e606-2ed9-4649-b513-3e3001df0c33',
    '--env', environment, '--path', folder, '--output', 'json', '--silent',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = JSON.parse(output) ?? [];
  return entries;
}
const redact = (text) => sensitive.sort((a,b) => b.length-a.length).reduce((s,value) =>
  s.split(value).join('[REDACTED]').split(JSON.stringify(value).slice(1,-1)).join('[REDACTED]'), text);
const result = { sandbox: values.sandbox, commands: [], uploads: [], downloads: [], secretNames: [] };
try {
  const key = secrets('prod', '/admin').find(x => x.secretKey === 'DAYTONA_API_KEY')?.secretValue;
  if (!key) throw Error('DAYTONA_API_KEY absent from explicit prod /admin scope');
  sensitive.push(key);
  const { Daytona } = await import(pathToFileURL(resolve(workspace, '_runtime/daytona-tools/node_modules/@daytona/sdk/esm/index.js')).href);
  const sandbox = await new Daytona({ apiKey: key }).get(values.sandbox);
  const env = {};
  if (values['secret-env']) {
    if (!values['secret-path'] || !values['secret-name']?.length) throw Error('Select explicit --secret-path and --secret-name for test credentials');
    const entries = secrets(values['secret-env'], values['secret-path']);
    for (const name of values['secret-name']) {
      const entry = entries.find(x => x.secretKey === name);
      if (!entry) throw Error(`Requested secret name unavailable: ${name}`);
      env[name] = entry.secretValue;
      if (entry.secretValue) sensitive.push(entry.secretValue);
      result.secretNames.push(name);
    }
  }
  if (values['upload-local']) {
    const remote = values['upload-remote'];
    if (!remote || !isAbsolute(remote)) throw Error('--upload-remote must be absolute');
    await sandbox.fs.uploadFile(resolve(values['upload-local']), remote);
    result.uploads.push({ local: resolve(values['upload-local']), remote });
  }
  if (values['exec-file']) {
    const script = readFileSync(resolve(values['exec-file']), 'utf8');
    // Command files contain commands, not credentials. Secrets use the API env map above.
    if (sensitive.some(value => script.includes(value))) throw Error('Command file contains a fetched secret; use selected secret environment injection instead');
    const command = `bash -lc '${script.replaceAll("'", "'\\''")}'`;
    const execution = await sandbox.process.executeCommand(command, values.cwd, env, 1800);
    result.commands.push({ command, cwd: values.cwd, ...execution });
    process.exitCode = execution.exitCode === 0 ? 0 : 1;
  }
  if (values['download-remote']) {
    if (!values['download-local']) throw Error('--download-local is required');
    const local = resolve(values['download-local']); mkdirSync(dirname(local), { recursive: true });
    const content = await sandbox.fs.downloadFile(values['download-remote']);
    // Downloads are text receipts only; never use this helper to export private config or tokens.
    writeFileSync(local, redact(content.toString('utf8')));
    result.downloads.push({ remote: values['download-remote'], local });
  }
  result.result = process.exitCode ? 'failed' : 'passed';
} catch (error) {
  result.result = 'failed'; result.error = redact(error.message); process.exitCode = 1;
} finally {
  writeFileSync(receipt, redact(JSON.stringify(result, null, 2)));
  console.log(JSON.stringify({ result: result.result, sandbox: values.sandbox, receipt }));
}
