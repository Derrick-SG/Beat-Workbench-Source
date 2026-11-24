import test from 'node:test';
import assert from 'node:assert/strict';
import {newWorkspace} from '../src/model/workspace.js';
import {createWorkspaceController} from '../src/storage/controller.js';
import {createBrowserRepository} from '../src/storage/browser.js';
import * as flow from '../src/timers/sessions.js';
test('empty-project start persists real origin; project edits preserve identity and settlement requires a project',async()=>{
 const w=newWorkspace(),data=new Map([['beat-workbench-current-v1',JSON.stringify(w)]]),repo=createBrowserRepository(null,{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}),c=createWorkspaceController({browserRepo:repo,settings:{read:async()=>({mode:'browser'})},directoryFactory(){}});await c.initialize();
 const intent=flow.createFlowStartIntent(w.workspaceId,w.activeProfileId,'',1000);await flow.startDurableFlow(c,intent);assert.equal((await repo.load()).sessions[0].draft.project,'');
 await assert.rejects(flow.settleDurableFlow(c,intent.id,{endAt:2000,now:3000}),/项目/);assert.equal(c.getWorkspace().sessions.length,1);
 await flow.updateDurableFlowProject(c,intent.id,'A');const save=repo.save;repo.save=async()=>{throw Error('write failed');};await assert.rejects(flow.updateDurableFlowProject(c,intent.id,'B'));assert.equal(c.getWorkspace().sessions[0].draft.project,'A');repo.save=save;await flow.updateDurableFlowProject(c,intent.id,'B');const s=(await repo.load()).sessions[0];assert.equal(s.id,intent.id);assert.equal(s.draft.startedAt,1000);assert.equal(s.draft.project,'B');
 const record=await flow.settleDurableFlow(c,intent.id,{endAt:2000,now:3000});assert.equal(record.project,'B');assert.equal(record.hours,1/3600);
});
test('abnormal empty-project session accepts project and actual end atomically',async()=>{
 const w=newWorkspace();let current=w;const c={getPending:()=>null,getWorkspace:()=>structuredClone(current),commit:async fn=>{current=fn(structuredClone(current));}};
 const intent=flow.createFlowStartIntent(w.workspaceId,w.activeProfileId,'',1000);await flow.startDurableFlow(c,intent);const r=await flow.settleDurableFlow(c,intent.id,{endAt:2500,now:3000,project:'补选'});assert.equal(r.project,'补选');assert.equal(r.hours,1.5/3600);assert.equal(current.sessions.length,0);
});
