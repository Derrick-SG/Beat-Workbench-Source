import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkspace } from '../src/model/workspace.js';

function disk() {
  const files=new Map(); let fail='';
  return {files,setFail:name=>fail=name,handle:{name:'synthetic',queryPermission:async()=> 'granted',getFileHandle:async(name,options)=>{
    if (!files.has(name) && !options?.create) throw Object.assign(Error('missing'),{name:'NotFoundError'});
    return {getFile:async()=>({text:async()=>files.get(name)||''}),createWritable:async()=>({write:async value=>{if(fail===name)throw Error('disk full');files.set(name,value);},close:async()=>{if(fail==='close')throw Error('close failed');},abort:async()=>{}})};
  }}};
}
test('directory does not initialize corrupt files, rejects conflicts and preserves previous snapshot',async()=>{
  const {createDirectoryRepository}=await import('../src/storage/directory.js');
  const d=disk(),repo=createDirectoryRepository(d.handle),w=newWorkspace();
  assert.equal(await repo.load(),null);
  await repo.save(w,null); const first=await repo.load();
  assert.equal(first.workspaceId,w.workspaceId);
  const next=structuredClone(first);next.revision=1;
  await repo.save(next,0);
  assert.equal(JSON.parse(d.files.get('beat-workbench.previous.json')).revision,0);
  const external=structuredClone(next); external.profiles[0].name='外部修改';
  d.files.set('beat-workbench.workspace.json',JSON.stringify(external));
  await assert.rejects(repo.save({...next,revision:2},1),{code:'conflict'});
  d.files.set('beat-workbench.workspace.json','');
  await assert.rejects(repo.load(),{code:'invalid'});
});
test('failed backup or close cannot report a successful save',async()=>{
  const {createDirectoryRepository}=await import('../src/storage/directory.js');
  const d=disk(),repo=createDirectoryRepository(d.handle),w=newWorkspace();await repo.save(w,null);
  const original=d.files.get('beat-workbench.workspace.json');
  d.setFail('beat-workbench.previous.json');await assert.rejects(repo.save({...w,revision:1},0));
  assert.equal(d.files.get('beat-workbench.workspace.json'),original);
  d.setFail('close');await assert.rejects(repo.save({...w,revision:1},0));
});
test('explicit repair preserves damaged primary bytes and supports retry',async()=>{
  const {createDirectoryRepository}=await import('../src/storage/directory.js');
  const d=disk(),repo=createDirectoryRepository(d.handle),w=newWorkspace();
  d.files.set('beat-workbench.previous.json',JSON.stringify(w));d.files.set('beat-workbench.workspace.json','broken original');
  await assert.rejects(repo.load());
  d.setFail('beat-workbench.workspace.json');await assert.rejects(repo.restorePrevious(true));
  assert.equal(d.files.get('beat-workbench.damaged.json'),'broken original');
  d.setFail('');
  await repo.restorePrevious(true);
  assert.equal(d.files.get('beat-workbench.damaged.json'),'broken original');
  assert.equal((await repo.load()).workspaceId,w.workspaceId);
});
