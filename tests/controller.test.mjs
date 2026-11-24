import test from 'node:test';
import assert from 'node:assert/strict';
import {newWorkspace} from '../src/model/workspace.js';
function repo(initial){let w=initial;return {load:async()=>structuredClone(w),save:async v=>{w=structuredClone(v);return{revision:v.revision,savedAt:v.updatedAt};},flush:async()=>{}};}
test('controller commits serially, keeps official values on failure and switches only after confirmation',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  const w=newWorkspace(),browser=repo(w),directory=repo(null);let setting={mode:'browser'};
  const c=createWorkspaceController({browserRepo:browser,settings:{read:async()=>setting,write:async s=>{setting=s;}},directoryFactory:()=>directory});
  await c.initialize();
  await Promise.all([c.commit(v=>{v.profiles[0].name='第一';return v;}),c.commit(v=>{v.profiles[0].name+='二';return v;})]);
  assert.equal(c.getWorkspace().profiles[0].name,'第一二');
  directory.save=async()=>{throw Error('disk failed');};
  const preview=await c.previewDirectory({name:'folder'});
  await c.activateDirectory(preview,false);assert.equal(c.getState().mode,'browser');
  await assert.rejects(c.activateDirectory(preview,true));assert.equal(c.getState().mode,'browser');
  assert.equal(c.getWorkspace().profiles[0].name,'第一二');
});
test('unreadable selected directory prevents default writes and allows explicit original-browser fallback',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  const w=newWorkspace(),browser=repo(w);let writes=0;
  const c=createWorkspaceController({browserRepo:browser,settings:{read:async()=>({mode:'directory',handle:{name:'locked'}}),write:async()=>{writes++;}},directoryFactory:()=>({load:async()=>{throw Error('permission denied');}})});
  await c.initialize();assert.equal(c.getState().phase,'reconnect');assert.equal(c.getWorkspace(),null);assert.equal(writes,0);
  await c.useOriginalBrowserData(true);assert.equal(c.getWorkspace().workspaceId,w.workspaceId);assert.equal(c.getState().mode,'browser');
});
test('directory confirmation re-reads and refuses a changed preview',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  const browser=repo(newWorkspace()),directory=repo(newWorkspace());
  const c=createWorkspaceController({browserRepo:browser,settings:{read:async()=>({mode:'browser'}),write:async()=>{}},directoryFactory:()=>directory});await c.initialize();
  const preview=await c.previewDirectory({name:'folder'}),changed=await directory.load();changed.profiles[0].name='changed';await directory.save(changed);
  await assert.rejects(c.activateDirectory(preview,true),{code:'conflict'});assert.equal(c.getState().mode,'browser');
});

test('migration preserves the complete workspace and refuses occupied destinations without switching',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  const w=newWorkspace();w.profiles[0].avatar={mime:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgo='};w.profiles[0].records=[{id:1,workDate:'2026-10-10',title:'合成记录',project:'A',hours:1,startTime:'09:00',endTime:'10:00'}];w.profiles.push({id:'second-user',name:'第二合成用户',avatar:null,records:[],tasks:[]});w.settledSessionIds=['settled-synthetic'];w.profiles[0].tasks=[{id:'task',text:'合成任务',project:'A',completed:false}];
  const browser=repo(w),directory=repo(null);let setting={mode:'browser'},writes=0;
  const save=directory.save;directory.save=async v=>{writes++;return save(v);};
  const c=createWorkspaceController({browserRepo:browser,settings:{read:async()=>setting,write:async v=>{setting=v;}},directoryFactory:()=>directory});await c.initialize();
  let preview=await c.previewDirectory({name:'empty'});
  await c.migrateDirectory(preview,false);assert.equal(writes,0);
  await c.migrateDirectory(preview,true);assert.deepEqual(await directory.load(),w);assert.deepEqual(await browser.load(),w);assert.deepEqual(c.getWorkspace(),w);
  const occupied=newWorkspace();await save(occupied);preview=await c.previewDirectory({name:'occupied'});
  await assert.rejects(c.migrateDirectory(preview,true),{code:'occupied'});assert.deepEqual(await directory.load(),occupied);assert.deepEqual(c.getWorkspace(),w);assert.equal(writes,1);
});

test('migration readback failure keeps original source and does not save source settings',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  const w=newWorkspace();let saved=false,settingsWrites=0;
  const directory={load:async()=>saved?newWorkspace():null,save:async()=>{saved=true;return{};}};
  const c=createWorkspaceController({browserRepo:repo(w),settings:{read:async()=>({mode:'browser'}),write:async()=>settingsWrites++},directoryFactory:()=>directory});await c.initialize();
  await assert.rejects(c.migrateDirectory(await c.previewDirectory({name:'bad-readback'}),true),/重新读取/);
  assert.equal(c.getState().mode,'browser');assert.deepEqual(c.getWorkspace(),w);assert.equal(settingsWrites,0);
});

test('migration settings failure leaves source identity intact and never changes old repository',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  const w=newWorkspace(),browser=repo(w),directory=repo(null);let calls=0;
  const c=createWorkspaceController({browserRepo:browser,settings:{read:async()=>({mode:'browser'}),write:async()=>{calls++;throw Error('settings failed');}},directoryFactory:()=>directory});await c.initialize();
  await assert.rejects(c.migrateDirectory(await c.previewDirectory({name:'settings-fail'}),true),/目标可能已生成副本/);
  assert.equal(calls,1);assert.equal(c.getSource().mode,'browser');assert.equal(c.getState().mode,'browser');assert.deepEqual(c.getWorkspace(),w);assert.deepEqual(await browser.load(),w);assert.deepEqual(await directory.load(),w);
});

test('directory migration routes subsequent records to new repository and reopens persisted source',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  const original=newWorkspace(),old=repo(original),destination=repo(null);let source={mode:'directory',handle:{name:'old'}};
  const options={browserRepo:{load:async()=>{throw Error('must not load browser');}},settings:{read:async()=>source,write:async v=>{source=v;}},directoryFactory:handle=>handle.name==='old'?old:destination};
  const c=createWorkspaceController(options);await c.initialize();await c.migrateDirectory(await c.previewDirectory({name:'new'}),true);
  const record={id:1,title:'迁移后合成记录',project:'A',workDate:'2026-10-14',hours:1,startTime:'09:00',endTime:'10:00'};
  await c.commit(w=>{w.profiles[0].records.push(record);return w;});assert.deepEqual(await old.load(),original);assert.deepEqual((await destination.load()).profiles[0].records,[record]);
  const reopened=createWorkspaceController(options);await reopened.initialize();assert.equal(reopened.getSource().handle.name,'new');assert.deepEqual(reopened.getWorkspace().profiles[0].records,[record]);
});

test('timed-out save fences late writes and rejects retry until original writer finishes',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');
  let disk=newWorkspace(),release,writerCalls=0;const done=new Promise(r=>release=r);
  const c=createWorkspaceController({saveTimeoutMs:10,browserRepo:{load:async()=>structuredClone(disk),save:async v=>{writerCalls++;await done;disk=structuredClone(v);return {savedAt:v.updatedAt};}},settings:{read:async()=>({mode:'browser'})},directoryFactory:()=>{}});await c.initialize();const original=c.getWorkspace();
  await assert.rejects(c.commit(w=>{w.profiles[0].name='新名';return w;}),/超时/);assert.equal(c.getState().phase,'stalled');assert.deepEqual(c.getWorkspace(),original);
  await assert.rejects(c.retry(),/仍在/);await assert.rejects(c.commit(w=>w),/仍在|尚未/);assert.equal(writerCalls,1);
  release();await new Promise(r=>setTimeout(r,5));assert.deepEqual(c.getWorkspace(),original);assert.ok(c.getPending());await c.retry();assert.equal(c.getWorkspace().profiles[0].name,'新名');assert.equal(writerCalls,1);
});

test('retry has same deadline and writer fence; no concurrent retry after failed initial save',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');let disk=newWorkspace(),calls=0,release;const wait=new Promise(r=>release=r);
  const c=createWorkspaceController({saveTimeoutMs:10,browserRepo:{load:async()=>structuredClone(disk),save:async v=>{calls++;if(calls===1)throw Error('first failed');await wait;disk=structuredClone(v);return{savedAt:v.updatedAt};}},settings:{read:async()=>({mode:'browser'})},directoryFactory:()=>{}});await c.initialize();await assert.rejects(c.commit(w=>{w.profiles[0].name='retry';return w;}));
  const attempt=c.retry();await new Promise(r=>setTimeout(r,1));await assert.rejects(c.retry(),/仍在/);await assert.rejects(attempt,/超时/);assert.equal(calls,2);release();await new Promise(r=>setTimeout(r,5));assert.notEqual(c.getWorkspace().profiles[0].name,'retry');await c.retry();assert.equal(c.getWorkspace().profiles[0].name,'retry');assert.equal(calls,2);
});

test('save queue is bounded and expired queued requests never become late writes',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');let disk=newWorkspace(),calls=0,release;const wait=new Promise(r=>release=r);
  const c=createWorkspaceController({saveTimeoutMs:10,maxQueuedCommits:2,browserRepo:{load:async()=>structuredClone(disk),save:async v=>{calls++;await wait;disk=structuredClone(v);return {savedAt:v.updatedAt};}},settings:{read:async()=>({mode:'browser'})},directoryFactory:()=>{}});await c.initialize();
  const first=c.commit(w=>{w.profiles[0].name='first';return w;}),second=c.commit(w=>{w.profiles[0].name='second';return w;});await assert.rejects(c.commit(w=>w),/队列已满/);const outcomes=await Promise.allSettled([first,second]);assert.ok(outcomes.every(r=>r.status==='rejected'));assert.equal(calls,1);
  release();await new Promise(r=>setTimeout(r,5));await c.retry();assert.equal(c.getWorkspace().profiles[0].name,'first');assert.equal(calls,1);
});

test('queued source switch rejects promptly and an expired pre-save read never starts a late write',async()=>{
  const {createWorkspaceController}=await import('../src/storage/controller.js');let disk=newWorkspace(),hold=false,release,calls=0;const wait=new Promise(r=>release=r);
  const c=createWorkspaceController({saveTimeoutMs:10,browserRepo:{load:async()=>{if(hold)await wait;return structuredClone(disk);},save:async v=>{calls++;disk=structuredClone(v);return{savedAt:v.updatedAt};}},settings:{read:async()=>({mode:'browser'}),write:async()=>{}},directoryFactory:()=>{}});await c.initialize();hold=true;const request=c.commit(w=>w);const timeout=assert.rejects(request,/超时/);
  try{const switchAttempt=c.returnToBrowser(true).then(()=> 'switched',()=> 'rejected');assert.equal(await Promise.race([switchAttempt,new Promise(r=>setTimeout(()=>r('still waiting'),20))]),'rejected');await timeout;}finally{release();await new Promise(r=>setTimeout(r,5));}
  assert.equal(calls,0);assert.ok(c.getPending());
});
