import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,access,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as time from '../src/model/time.js';
import {newWorkspace,settleLegacySnapshot,parseProfileBackup,makeProfileBackup} from '../src/model/workspace.js';
import {createBrowserRepository} from '../src/storage/browser.js';
import {createDirectoryRepository} from '../src/storage/directory.js';
import {createWorkspaceController} from '../src/storage/controller.js';
const app=readFileSync('src/app.js','utf8'),boot=readFileSync('src/bootstrap.js','utf8');
const names=['completeFlow','flowTaskTitle','timeString','dateKey','applySessionRecord','sessionSnapshot','beginSession','persistData','save','persistProfiles','normalizeImportedRecords','normalizeCategory','normalizeTask','normalizeTasks','uniqueProfileName','importBackup'];
const code=names.map(n=>app.match(new RegExp('    (?:async )?function '+n+'\\([\\s\\S]*?\\n    }'))[0]).join('\n')+'\n'+boot.match(/  async function flushLegacy\(\)[\s\S]*?\n  }/)[0];
for(const directory of [false,true])test('production flow/save adapter/controller '+(directory?'directory bytes':'browser repository')+' persists 25h and imports into independent user',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'beat-flow-'));const localMap=new Map(),local={getItem:k=>localMap.get(k)??null,setItem:(k,v)=>localMap.set(k,v)};
  const handle={name:'synthetic',getFileHandle:async(name,options={})=>{const file=path.join(folder,name);try{await access(file);}catch{if(!options.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});}return {getFile:async()=>({text:async()=>readFile(file,'utf8')}),createWritable:async()=>{let text;return{write:async v=>{text=v;},close:async()=>writeFile(file,text),abort:async()=>{}};}};}};
  try{
    const initial=newWorkspace();local.setItem('beat-workbench-current-v1',JSON.stringify(initial));const browser=createBrowserRepository(null,local),disk=createDirectoryRepository(handle);
    if(directory){await disk.load();await disk.save(initial,null);}
    const controller=createWorkspaceController({browserRepo:browser,settings:{read:async()=>directory?{mode:'directory',handle}:{mode:'browser'},write:async()=>{}},directoryFactory:()=>disk});await controller.initialize();
    let now=new Date('2026-10-14T23:30:00').getTime();class Clock extends Date{constructor(v){super(v===undefined?now:v);}static now(){return now;}}
    const map=new Map(),c=vm.createContext({...time,Date:Clock,structuredClone,globalThis:{crypto:{randomUUID:()=> 'synthetic-session'}},controller,settleLegacySnapshot,parseProfileBackup,makeProfileBackup,validateAvatar:async v=>v,map,legacyDirty:false,pending:false,toastQueue:[],flowStartedAt:new Clock(),meetingStartedAt:null,meetingDraft:null,taskTracking:null,flowDraftTasks:[],sessionIds:{},sessionRuns:{},tasks:[],logs:[],profiles:[],activeProfileId:initial.activeProfileId,profilesStoreKey:'jiepai-user-profiles-v1',activeProfileStoreKey:'jiepai-active-profile-v1',profileDataKey:id=>'jiepai-work-logs-v2:'+id,profileTasksKey:id=>'jiepai-project-tasks-v1:'+id,workbench:{isDirectory:()=>directory,controller},get:id=>({value:id==='flow-project'?'A':'项目推进',reset(){}}),taskSummary:()=>'',timeAfter:()=>'',addPersistentTasks(){},clearFlowTimer(){},renderDraftTasks(){},updateFlowControls(){},switchFeaturePanel(){},render(){},renderProfiles(){},resetReportEditors(){},resetWorkForm(){},today:()=> '2026-10-14',toast:()=>{},window:{appStorage:{setItem:(k,v)=>{map.set(k,v);c.legacyDirty=true;}}},FileReader:class{readAsText(file){this.result=file.text;c.importDone=this.onload();}}});
    c.sync=()=>{const w=controller.getWorkspace();c.profiles=w.profiles.map(({id,name,avatar})=>({id,name,avatar}));c.activeProfileId=w.activeProfileId;c.logs=w.profiles.find(p=>p.id===w.activeProfileId).records;c.tasks=w.profiles.find(p=>p.id===w.activeProfileId).tasks;map.set('jiepai-user-profiles-v1',JSON.stringify(c.profiles));map.set('jiepai-active-profile-v1',w.activeProfileId);for(const p of w.profiles){map.set(c.profileDataKey(p.id),JSON.stringify(p.records));map.set(c.profileTasksKey(p.id),JSON.stringify(p.tasks));}};
    vm.runInContext(code,c);c.sync();await c.beginSession('flow');now+=25*3600000;assert.equal(c.completeFlow(),'saved');await c.flushLegacy();
    const persisted=await (directory?createDirectoryRepository(handle):createBrowserRepository(null,local)).load();assert.equal(persisted.profiles[0].records[0].hours,25);assert.equal(time.recordsInRange(persisted.profiles[0].records).reduce((n,r)=>n+r.hours,0),25);
    const backup=makeProfileBackup(persisted.profiles[0]);c.importBackup({name:'synthetic.json',text:JSON.stringify(backup)});await c.importDone;await c.flushLegacy();
    const reloaded=await (directory?createDirectoryRepository(handle):createBrowserRepository(null,local)).load();assert.equal(reloaded.profiles.length,2);for(const p of reloaded.profiles){assert.equal(p.records.length,1);assert.equal(p.records[0].hours,25);assert.equal(time.recordsInRange(p.records).reduce((n,r)=>n+r.hours,0),25);}
  }finally{for(const name of ['beat-workbench.workspace.json','beat-workbench.previous.json'])try{await unlink(path.join(folder,name));}catch(e){if(e.code!=='ENOENT')throw e;}await rmdir(folder);}
});
