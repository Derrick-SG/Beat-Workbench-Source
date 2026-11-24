import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as flows from '../src/timers/sessions.js';
import * as time from '../src/model/time.js';
import {newWorkspace} from '../src/model/workspace.js';
import {createBrowserRepository} from '../src/storage/browser.js';
import {createWorkspaceController} from '../src/storage/controller.js';
const source=readFileSync('src/app.js','utf8');
const names=['startSelectedFlow','updateFlowStartControls','updateFlowControls','formatMeetingElapsed','clearFlowTimer','completePersistedFlow','flowTaskTitle','sessionSnapshot','dateKey','timeString','formatFlowTimestamp','createFlowRecoveryBox','pendingRecoveryFlows','renderFlowRecovery','recoverCheckpointFlows','checkpointSessions','completeFlowOnPageExit','resumeFlowPage'];
const code=names.map(n=>source.match(new RegExp('    (?:async )?function '+n+'\\([\\s\\S]*?\\n    }'))[0]).join('\n');
async function harness(){
  let now=new Date('2026-12-31T23:30:00').getTime();class Clock extends Date{constructor(v){super(v===undefined?now:v);}static now(){return now;}}
  const w=newWorkspace(),map=new Map([['beat-workbench-current-v1',JSON.stringify(w)]]),local={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)},repo=createBrowserRepository(null,local),controller=createWorkspaceController({browserRepo:repo,settings:{read:async()=>({mode:'browser'})},directoryFactory:()=>{}});await controller.initialize();
  const fields=new Map(),elements=new Map(['main','body > header','.main-nav'].map(k=>[k,{inert:false}]));
  const get=id=>{if(!fields.has(id))fields.set(id,{value:id==='flow-project'?'A':id==='flow-category'?'项目推进':'',textContent:'',disabled:false,hidden:false,focus(){if(!this.disabled)this.focused=true;},reset(){},querySelector(){return {append(){}};}});return fields.get(id);};
  const document={querySelector:k=>elements.get(k),body:{append(){},prepend(){}},createElement:()=>({dataset:{},children:[],append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},setAttribute(){},open:false,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();}})};
  const c=vm.createContext({...flows,...time,Date:Clock,structuredClone,queueMicrotask,document,get,flowStartedAt:null,flowStartIntent:null,flowStartBusy:false,flowFinishIntent:null,flowFinishBusy:false,flowRecoveryBusy:false,flowRecoveryAttempt:'',flowRecoveryPromise:null,flowPageEpoch:0,checkpointBusy:false,flowDraftTasks:[],meetingDraftTasks:[],meetingStartedAt:null,meetingDraft:null,taskTracking:null,flowTimer:null,sessionIds:{},sessionRuns:{},activeProfileId:w.activeProfileId,window:{setInterval:()=>1,clearInterval(){}},renderDraftTasks(){},switchFeaturePanel(){},toast(){},taskSummary:()=>'',workbench:{controller,temporary:false,isDirectory:()=>false,isPending:()=>!!controller.getPending(),exportCurrentSnapshot:()=>{c.exports++;},requestSourceAccess:async()=>{},sync:()=>{c.renderFlowRecovery();}},exports:0});
  vm.runInContext(code,c);c.flowRecoveryBox=c.createFlowRecoveryBox();return {c,get,repo,controller,elements,w,start:now,setNow:v=>now=v};
}
const inputTime=ms=>{const d=new Date(ms);return new Date(ms-d.getTimezoneOffset()*60000).toISOString().slice(0,23);};
test('actual start UI activates only after acknowledgment; failed start preserves retry identity/project',async()=>{
  const {c,get,repo,controller,start}=await harness(),save=repo.save;repo.save=async()=>{throw Error('write failed');};await c.startSelectedFlow();const id=c.flowStartIntent.id;assert.equal(c.flowStartedAt,null);assert.equal(get('flow-project').value,'A');assert.match(get('flow-save-state').textContent,/尚未启动/);
  repo.save=save;await c.startSelectedFlow();assert.equal(c.flowStartedAt.getTime(),start);assert.equal(controller.getWorkspace().sessions.length,1);assert.equal(controller.getWorkspace().sessions[0].id,id);assert.equal(get('flow-project').disabled,false);
});
for(const duration of [4000,25*3600000,49*3600000])test('actual normal completion '+duration+'ms remains segmented and waits for acknowledged persistence',async()=>{
  const {c,controller,start,setNow}=await harness();await c.startSelectedFlow();setNow(start+duration);assert.equal(await c.completePersistedFlow(),'saved');assert.equal(c.flowStartedAt,null);assert.equal(controller.getWorkspace().profiles[0].records[0].hours,duration/3600000);assert.equal(controller.getWorkspace().profiles[0].records[0].flowSettlement,'segments');
});

test('actual start UI remains unstarted while writer is held, then activates original captured time',async()=>{
  const {c,repo,start}=await harness(),save=repo.save;let release;const wait=new Promise(r=>release=r);repo.save=async(...args)=>{await wait;return save(...args);};const attempt=c.startSelectedFlow();await new Promise(r=>setTimeout(r,1));assert.equal(c.flowStartedAt,null);assert.equal(c.flowStartBusy,true);release();await attempt;assert.equal(c.flowStartedAt.getTime(),start);
});

test('browser checkpoint preserves start policy and shows failures on visible flow page',async()=>{
  const {c,get,repo,controller,start,setNow}=await harness();await c.startSelectedFlow();setNow(start+20000);await c.checkpointSessions();const session=controller.getWorkspace().sessions[0];assert.equal(session.draft.recoveryPolicy,'checkpoint-end');assert.equal(session.draft.startedAt,start);assert.match(get('flow-save-state').textContent,/最近成功检查点/);
  repo.save=async()=>{throw Error('checkpoint failure');};setNow(start+40000);await c.checkpointSessions();assert.match(get('flow-save-state').textContent,/心流检查点未保存/);assert.match(get('flow-save-state').textContent,/最近成功检查点/);assert.ok(controller.getPending());
});


test('normal UI finish keeps timer context on uncertain receipt and retries one record',async()=>{
  const {c,get,controller,repo,start,setNow}=await harness();await c.startSelectedFlow();const save=repo.save;let fail=true;repo.save=async(...args)=>{const receipt=await save(...args);if(fail){fail=false;throw Error('receipt lost');}return receipt;};setNow(start+10000);assert.equal(await c.completePersistedFlow(),'save-failed');assert.ok(c.flowStartedAt);assert.ok(c.flowFinishIntent);assert.match(get('flow-save-state').textContent,/尚未保存/);assert.equal(await c.completePersistedFlow(),'saved');assert.equal(c.flowStartedAt,null);assert.equal(controller.getWorkspace().profiles[0].records.length,1);
});


test('empty project starts now; normal completion retains live time until project supplied',async()=>{
 const {c,get,controller,start,setNow}=await harness();get('flow-project').value='';await c.startSelectedFlow();assert.equal(c.flowStartedAt.getTime(),start);assert.match(get('flow-live-label').textContent,/未选择项目/);setNow(start+10000);assert.equal(await c.completePersistedFlow(),'missing-project');assert.ok(c.flowStartedAt);assert.equal(controller.getWorkspace().sessions.length,1);get('flow-project').value='后选项目';assert.equal(await c.completePersistedFlow(),'saved');const r=controller.getWorkspace().profiles[0].records[0];assert.equal(r.project,'后选项目');assert.equal(r.hours,10/3600);
});

test('reopen auto settles checkpoint without modal or background inert; live session is excluded',async()=>{
 const {c,get,controller,start,setNow}=await harness();await c.startSelectedFlow();setNow(start+15000);await c.checkpointSessions();await c.renderFlowRecovery();assert.equal(controller.getWorkspace().sessions.length,1);delete c.sessionIds.flow;c.flowStartedAt=null;setNow(start+3600000);await c.renderFlowRecovery();assert.equal(controller.getWorkspace().profiles[0].records[0].hours,15/3600);assert.equal(controller.getWorkspace().sessions.length,0);assert.match(get('flow-save-state').textContent,/检查点/);assert.equal(source.includes('flow-recovery-end'),false);
});
test('origin-only BFCache return auto closes with receipt and no fake work',async()=>{
 const {c,controller,start,setNow}=await harness();await c.startSelectedFlow();setNow(start+3600000);c.completeFlowOnPageExit({type:'pagehide',persisted:true});c.resumeFlowPage({persisted:true});await c.flowRecoveryPromise;assert.equal(controller.getWorkspace().profiles[0].records.length,0);assert.equal(controller.getWorkspace().flowClosures[0].startedAt,start);assert.equal(controller.getWorkspace().sessions.length,0);
});
test('automatic save failure retains session and offers nonmodal retry and export',async()=>{
 const {c,controller,repo,start,setNow}=await harness();await c.startSelectedFlow();setNow(start+15000);await c.checkpointSessions();delete c.sessionIds.flow;c.flowStartedAt=null;const save=repo.save;repo.save=async()=>{throw Error('write failed');};await c.renderFlowRecovery();assert.equal(controller.getWorkspace().sessions.length,1);const retry=c.flowRecoveryBox.children.find(n=>n.textContent==='重试自动保存'),exportButton=c.flowRecoveryBox.children.find(n=>n.textContent==='导出全工作台待保存数据');assert.ok(retry);exportButton.onclick();assert.equal(c.exports,1);repo.save=save;await retry.onclick();assert.equal(controller.getWorkspace().sessions.length,0);assert.equal(controller.getWorkspace().profiles[0].records.length,1);
});
