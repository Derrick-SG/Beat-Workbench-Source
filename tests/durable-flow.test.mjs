import test from 'node:test';
import assert from 'node:assert/strict';
import {newWorkspace} from '../src/model/workspace.js';
import {createWorkspaceController} from '../src/storage/controller.js';
import {createBrowserRepository} from '../src/storage/browser.js';
import {createFlowStartIntent,startDurableFlow,settleDurableFlow,validateFlowEnd,flowStartTime} from '../src/timers/sessions.js';
const start=new Date('2026-10-16T23:30:00').getTime();
async function harness(){const map=new Map(),w=newWorkspace();map.set('beat-workbench-current-v1',JSON.stringify(w));const local={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)},repo=createBrowserRepository(null,local),c=createWorkspaceController({browserRepo:repo,settings:{read:async()=>({mode:'browser'})},directoryFactory:()=>{}});await c.initialize();return {c,repo,map,local,w};}
test('durable browser flow start and abnormal full-span settlement survive repository reopen and repeated confirmation',async()=>{
  const {c,local,w}=await harness(),intent=createFlowStartIntent(w.workspaceId,w.activeProfileId,'A',start);await startDurableFlow(c,intent);const reopened=await createBrowserRepository(null,local).load();assert.equal(reopened.sessions.length,1);assert.equal(reopened.sessions[0].draft.startedAt,start);assert.equal(reopened.sessions[0].draft.project,'A');
  const record=await settleDurableFlow(c,intent.id,{endAt:start+25*3600000,now:start+26*3600000});assert.equal(record.hours,25);assert.equal(c.getWorkspace().sessions.length,0);assert.equal((await settleDurableFlow(c,intent.id,{endAt:start+25*3600000,now:start+26*3600000})).id,record.id);assert.equal(c.getWorkspace().profiles[0].records.length,1);
});
test('failed start preserves intent and retry activates exactly one durable flow',async()=>{
  const {c,w,repo}=await harness(),intent=createFlowStartIntent(w.workspaceId,w.activeProfileId,'A',start),save=repo.save;repo.save=async()=>{throw Error('disk failed');};await assert.rejects(startDurableFlow(c,intent));assert.equal(c.getWorkspace().sessions.length,0);repo.save=save;await startDurableFlow(c,intent);assert.equal(c.getWorkspace().sessions.length,1);assert.equal(c.getWorkspace().sessions[0].id,intent.id);
});
test('uncertain settlement receipt retry deduplicates and normal segmented time excludes gaps',async()=>{
  const {c,w,repo}=await harness(),intent=createFlowStartIntent(w.workspaceId,w.activeProfileId,'A',start);await startDurableFlow(c,intent);const save=repo.save;let first=true;repo.save=async(...args)=>{const result=await save(...args);if(first){first=false;throw Error('receipt lost');}return result;};
  const args={endAt:start+3600000+30000,now:start+7200000,segments:[{start,end:start+15000},{start:start+3600000+15000,end:start+3600000+30000}]};await assert.rejects(settleDurableFlow(c,intent.id,args));assert.equal(c.getWorkspace().sessions.length,1);const record=await settleDurableFlow(c,intent.id,args);assert.equal(record.hours,30/3600);assert.equal(c.getWorkspace().profiles[0].records.length,1);
});
test('legacy flow start is interpreted, invalid/zero/future end rejected without fake minutes',()=>{
  const session={draft:{originDate:'2026-10-16',originTime:'23:30',segments:[{start,end:start+15000}]}};assert.equal(flowStartTime(session),start);for(const end of [NaN,start-1,start,start+5000])assert.throws(()=>validateFlowEnd(session,end,start+1000));assert.equal(validateFlowEnd(session,start+1000,start+1000),start+1000);
});
