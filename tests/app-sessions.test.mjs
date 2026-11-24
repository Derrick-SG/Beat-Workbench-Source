import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {newWorkspace,validateWorkspace} from '../src/model/workspace.js';
import {segmentHours,recordsInRange,splitTimeSegments} from '../src/model/time.js';

test('production timer wrappers checkpoint and restore only actual work segments for all timer kinds',async()=>{
  const source=readFileSync('src/app.js','utf8');
  const names=['sessionSnapshot','beginSession','applySessionRecord','checkpointSessions','formatFlowTimestamp','dateKey','timeString'];
  const code=names.map(name=>source.match(new RegExp('    (?:async )?function '+name+'\\([\\s\\S]*?\\n    }'))[0]).join('\n');
  for(const kind of ['flow','meeting','task']){
    let now=new Date('2026-10-09T09:00:00').getTime(),w=newWorkspace();
    class Clock extends Date {constructor(value){super(value===undefined?now:value);}static now(){return now;}}
    const controller={getWorkspace:()=>structuredClone(w),commit:async fn=>{w=validateWorkspace(fn(structuredClone(w)));}};
    const c=vm.createContext({Date:Clock,globalThis:{crypto:{randomUUID:()=>kind+'-session'}},workbench:{isDirectory:()=>true,isPending:()=>false,controller},sessionIds:{},sessionRuns:{},checkpointBusy:false,flowFinishBusy:false,flowStartTime:s=>s.draft.segments[0]?.start||now,activeProfileId:w.activeProfileId,flowStartedAt:kind==='flow'?new Clock():null,meetingStartedAt:kind==='meeting'?new Clock():null,taskTracking:kind==='task'?{project:'A',startedAt:new Clock()}:null,meetingDraft:null,flowDraftTasks:[],meetingDraftTasks:[],get:id=>({value:id.includes('category')?'项目推进':'A'}),toast:()=>{},segmentHours,splitTimeSegments});
    vm.runInContext(code,c);await c.beginSession(kind);now+=15000;await c.checkpointSessions();
    const saved=structuredClone(w.sessions[0]);assert.equal(saved.elapsedMs,15000);
    now+=3600000;c.sessionRuns[kind]={start:now,prior:saved.draft.segments,restored:true};
    const resumed=new Clock(now-saved.elapsedMs);
    if(kind==='flow')c.flowStartedAt=resumed;if(kind==='meeting')c.meetingStartedAt=resumed;if(kind==='task')c.taskTracking.startedAt=resumed;
    now+=15000;
    const record={id:1,title:'合成',project:'A',workDate:'2026-10-09',hours:1,startTime:'09:00',endTime:'10:00'};
    c.applySessionRecord(record,kind);
    assert.equal(record.hours,30/3600);
    for(const range of [{start:'2026-10-09',end:'2026-10-09'},{start:'2026-10-05',end:'2026-10-11'},{start:'2026-10-01',end:'2026-10-31'},{start:'2026-01-01',end:'2026-12-31'}])assert.equal(recordsInRange([record],range)[0]._ranges.reduce((n,s)=>n+s.end-s.start,0),.5);
  }
});
