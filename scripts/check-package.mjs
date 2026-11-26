import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const scratch = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ei-package-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const archive = path.join(scratch, 'copydesk.tgz');
  run('bun', ['pm', 'pack', '--filename', archive, '--ignore-scripts', '--quiet'], root);
  const members = run('tar', ['-tzf', archive], root).trim().split('\n');
  for (const name of ['package/src/index.ts', 'package/src/host.ts', 'package/src/generated/editorinterop/v1/editor_interop_pb.ts', 'package/resources/nvim/bootstrap.lua', 'package/resources/nvim/lua/copydesk_prompt.lua', 'package/LICENSE.md', 'package/NOTICE.md']) assert.ok(members.includes(name), `Missing packaged resource: ${name}`);
  assert.ok(!members.some((name) => /(?:^|\/)(?:node_modules|\.git|\.socrates|\.worktrees)(?:\/|$)/.test(name)), 'Package contains development state');
  const consumer = path.join(scratch, 'consumer');
  await mkdir(consumer);
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@lanej/copydesk': `file:${archive}`, '@bufbuild/protobuf': source.dependencies['@bufbuild/protobuf'] } }));
  run('bun', ['install', '--ignore-scripts'], consumer);
  await writeFile(path.join(consumer, 'smoke.ts'), `
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from '@bufbuild/protobuf';
import { createWorkspace } from '@lanej/copydesk';
import { HOST_CONFORMANCE_CASES } from '@lanej/copydesk/testing';
assert.ok(Object.keys(HOST_CONFORMANCE_CASES).length > 0);
import { CallContextSchema, SessionRefSchema, SyncHeaderSchema } from '@lanej/copydesk/protocol';
const session = create(SessionRefSchema, {providerId:'package-fixture',projectId:'project',conversationId:'conversation'});
const context = create(CallContextSchema, {session,generation:'package-generation'});
let subscribed = false;
let closed = 0;
let disposed = false;
const runtimePath = dirname(fileURLToPath(import.meta.resolve('@lanej/copydesk/neovim')));
assert.ok((await readFile(join(runtimePath,'bootstrap.lua'),'utf8')).includes('copydesk'));
const unexpected = async () => { throw new Error('Empty host must not launch or mutate'); };
const workspace = await createWorkspace({context,provider:{
 openSnapshot:async () => ({header:create(SyncHeaderSchema,{session}),next:async()=>undefined,close:async()=>{closed++;}}),
 save:unexpected,submitFeedback:unexpected,onChanged:()=>{subscribed=true;return()=>{subscribed=false;};}
},launcher:{ensure:unexpected,inspect:unexpected,verifyRegistration:unexpected,dispose:async()=>{disposed=true;}},
 directory:join(process.cwd(),'private-session'),runtimePath,workingDirectory:process.cwd(),title:'Packaged fixture'});
try {
 assert.equal(subscribed,true);
 assert.ok(closed>0,'Initial snapshot reader was not closed');
 assert.equal((await stat(workspace.manifestPath)).mode & 0o777,0o600);
 await workspace.refresh();
} finally { await workspace.dispose(); }
assert.equal(subscribed,false);
assert.equal(disposed,true);
console.log('Isolated package: exports, runtime resources, private endpoint and lifecycle passed.');
`);
  process.stdout.write(run('bun', ['smoke.ts'], consumer));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
