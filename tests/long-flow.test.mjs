import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as time from '../src/model/time.js';
import {newWorkspace,validateWorkspace} from '../src/model/workspace.js';
const source=readFileSync('src/app.js','utf8');
const names=['completeFlow','flowTaskTitle','timeString','dateKey','formatMeetingElapsed','applySessionRecord','sessionSnapshot','beginSession'];
const code=names.map(n=>source.match(new RegExp('    (?:async )?function '+n+'\\([\\s\\S]*?\\n    }'))[0]).join('\n');
for(const hours of [24,25,49])for(const directory of [false,true])test('production flow completes '+hours+'h across midnight in '+(directory?'directory':'browser')+' mode',async()=>{
  const start=new Date('2026-10-14T23:30:00').getTime();let now=start,w=newWorkspace();
  class Clock extends Date{constructor(v){super(v===undefined?now:v);}static now(){return now;}}
  const c=vm.createContext({Date:Clock,globalThis:{crypto:{randomUUID:()=> 'flow-test'}},segmentHours:time.segmentHours,splitTimeSegments:time.splitTimeSegments,flowStartedAt:new Clock(start),flowDraftTasks:[],logs:[],sessionIds:{},sessionRuns:{},activeProfileId:w.activeProfileId,workbench:{isDirectory:()=>directory,controller:{getWorkspace:()=>w,commit:async fn=>{w=validateWorkspace(fn(structuredClone(w)));}}},get:id=>({value:id==='flow-project'?'A':'项目推进',reset(){}}),taskSummary:()=>'',timeAfter:()=>'',addPersistentTasks(){},clearFlowTimer(){},persistData(){},renderDraftTasks(){},updateFlowControls(){},save(){},switchFeaturePanel(){},toast(){}});
  vm.runInContext(code,c);await c.beginSession('flow');now+=hours*3600000;
  assert.equal(c.formatMeetingElapsed(now-start),hours+':00:00');assert.equal(c.completeFlow(),'saved');assert.equal(c.logs.length,1);
  const record=JSON.parse(JSON.stringify(c.logs[0]));assert.equal(record.hours,hours);assert.ok(record.timeSegments.length>=Math.ceil(hours/24));w.profiles[0].records=[record];assert.doesNotThrow(()=>validateWorkspace(w));
  const all=time.recordsInRange([record]);assert.deepEqual(all.map(r=>r.hours),hours===24?[.5,23.5]:hours===25?[.5,24,.5]:[.5,24,24,.5]);
  for(const range of [{start:'2026-10-12',end:'2026-10-18'},{start:'2026-10-01',end:'2026-10-31'},{start:'2026-01-01',end:'2026-12-31'}])assert.equal(time.recordsInRange([record],range).reduce((n,r)=>n+r.hours,0),hours);
});

test('editing multi-day flow metadata preserves timed duration and rejects single-day timing replacement',()=>{
  const start=new Date('2026-10-14T23:30:00').getTime(),existing={hours:25,workDate:'2026-10-14',startTime:'23:30',endTime:'00:30',sessionId:'stable',timeSegments:[{start,end:start+86400000},{start:start+86400000,end:start+25*3600000}]};
  const updated=time.preserveSegmentedTiming(existing,{...existing,title:'changed',hours:1,timeSegments:undefined});assert.equal(updated.hours,25);assert.deepEqual(updated.timeSegments,existing.timeSegments);assert.equal(updated.title,'changed');
  assert.throws(()=>time.preserveSegmentedTiming(existing,{...existing,startTime:'09:00'}),/日期|时段/);
});
