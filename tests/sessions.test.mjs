import test from 'node:test';
import assert from 'node:assert/strict';
import {newWorkspace} from '../src/model/workspace.js';
test('each timer restores only checkpointed elapsed time and settles once; discard creates no log',async()=>{
  const {createSessionManager}=await import('../src/timers/sessions.js');
  for(const kind of ['flow','meeting','task']){
    let w=newWorkspace(),now=0;const c={getWorkspace:()=>structuredClone(w),commit:async fn=>{w=fn(structuredClone(w));}};
    const options={controller:c,clock:()=>now,setInterval:()=>1,clearInterval:()=>{}};
    const s=createSessionManager(options);const id=await s.start(kind,w.activeProfileId,{project:'A'});now=15000;await s.checkpoint();
    const reopened=createSessionManager(options);now=3615000;await reopened.restore(id);
    now+=5000;await reopened.complete(id,x=>({id:1,hours:x.elapsedMs/3600000,sessionId:x.sessionId}));
    await reopened.complete(id,()=>{throw Error('duplicate');});assert.equal(w.profiles[0].records.length,1);assert.equal(w.profiles[0].records[0].hours,20000/3600000);
    const other=await reopened.start(kind,w.activeProfileId,{});await reopened.discard(other);assert.equal(w.profiles[0].records.length,1);
  }
});
