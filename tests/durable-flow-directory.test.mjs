import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,access,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {newWorkspace} from '../src/model/workspace.js';
import {createDirectoryRepository} from '../src/storage/directory.js';
import {createWorkspaceController} from '../src/storage/controller.js';
import {createFlowStartIntent,startDurableFlow,settleDurableFlow,settleCheckpointFlow} from '../src/timers/sessions.js';
import {recordsInRange} from '../src/model/time.js';

test('directory durable start and forced settlement reopen actual files, preserve owners and allocate midnight/year boundaries',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'beat-durable-flow-'));
  const handle={name:'synthetic',getFileHandle:async(name,options={})=>{const file=path.join(folder,name);try{await access(file);}catch{if(!options.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});}return{getFile:async()=>({text:async()=>readFile(file,'utf8')}),createWritable:async()=>{let text;return{write:async value=>{text=value;},close:async()=>writeFile(file,text),abort:async()=>{}};}};}};
  try{
    const w=newWorkspace();w.profiles.push({id:'other',name:'其他合成用户',avatar:null,records:[],tasks:[{id:'keep',text:'保持任务',project:'B',completed:false}]});const initial=createDirectoryRepository(handle);await initial.load();await initial.save(w,null);
    const settings={read:async()=>({mode:'directory',handle}),write:async()=>{}};const make=()=>createWorkspaceController({browserRepo:{load:async()=>{throw Error('no browser fallback');}},settings,directoryFactory:h=>createDirectoryRepository(h)});
    let c=make();await c.initialize();const start=new Date('2026-12-31T23:30:00').getTime(),intent=createFlowStartIntent(w.workspaceId,w.activeProfileId,'A',start);await startDurableFlow(c,intent);
    const started=JSON.parse(await readFile(path.join(folder,'beat-workbench.workspace.json'),'utf8'));assert.equal(started.sessions[0].draft.startedAt,start);assert.equal(started.sessions[0].profileId,w.activeProfileId);
    c=make();await c.initialize();const end=start+25*3600000;const record=await settleDurableFlow(c,intent.id,{endAt:end,now:end+3600000});assert.equal(record.hours,25);let reopened=make();await reopened.initialize();assert.equal(reopened.getWorkspace().sessions.length,0);assert.equal(reopened.getWorkspace().profiles[0].records.length,1);assert.deepEqual(reopened.getWorkspace().profiles[1],w.profiles[1]);
    const total=(start,end)=>recordsInRange([record],{start,end}).reduce((n,r)=>n+r.hours,0);assert.equal(total('2026-12-31','2026-12-31'),.5);assert.equal(total('2027-01-01','2027-01-01'),24);assert.equal(total('2027-01-02','2027-01-02'),.5);assert.equal(total('2026-12-28','2027-01-03'),25);assert.equal(total('2026-12-01','2026-12-31'),.5);assert.equal(total('2027-01-01','2027-01-31'),24.5);assert.equal(total('2026-01-01','2026-12-31'),.5);assert.equal(total('2027-01-01','2027-12-31'),24.5);
    await settleDurableFlow(reopened,intent.id,{endAt:end,now:end});assert.equal(reopened.getWorkspace().profiles[0].records.length,1);
    const auto=createFlowStartIntent(w.workspaceId,'other','',end+1000);await startDurableFlow(reopened,auto);await reopened.commit(value=>{const s=value.sessions.find(s=>s.id===auto.id);s.draft.segments=[{start:end+1000,end:end+16000}];s.elapsedMs=15000;s.checkpointAt=new Date(end+16000).toISOString();return value;});
    const autoReopened=make();await autoReopened.initialize();await settleCheckpointFlow(autoReopened,auto.id,end+86400000);const disk=JSON.parse(await readFile(path.join(folder,'beat-workbench.workspace.json'),'utf8'));assert.equal(disk.profiles[1].records[0].hours,15/3600);assert.equal(disk.profiles[1].records[0].project,'未分类');assert.equal(disk.sessions.length,0);
  }finally{for(const name of ['beat-workbench.workspace.json','beat-workbench.previous.json'])try{await unlink(path.join(folder,name));}catch(e){if(e.code!=='ENOENT')throw e;}await rmdir(folder);}
});
