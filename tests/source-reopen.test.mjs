import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {newWorkspace} from '../src/model/workspace.js';
import {createWorkspaceController} from '../src/storage/controller.js';
import * as settingsModule from '../src/storage/settings.js';
const boot=readFileSync('src/bootstrap.js','utf8');
test('source settings read failure cannot silently reopen/browser-save an older workspace',async()=>{
  const read=async()=>{throw Error('IndexedDB blocked');},write=async()=>{};
  const c=vm.createContext({readSourceSettings:read,writeSourceSettings:write,settingsAvailable:true,globalThis:{indexedDB:{}},location:{protocol:'http:'},createSourceSettings:options=>settingsModule.createSourceSettings({...options,read,write})});
  const line=boot.match(/  const settings=[^\n]+/)[0];vm.runInContext(line+'\nglobalThis.testSettings=settings;',c);
  let browserWrites=0;const controller=createWorkspaceController({browserRepo:{load:async()=>newWorkspace(),save:async()=>{browserWrites++;}},settings:c.globalThis.testSettings,directoryFactory:()=>{throw Error('not expected');}});
  await controller.initialize();assert.equal(controller.getWorkspace(),null);assert.equal(controller.getState().phase,'reconnect');assert.equal(browserWrites,0);
});
test('page exit guard blocks only unfinished persistence, including legacy dirty data',()=>{
  const code=boot.match(/  function protectPageExit\(event\)[\s\S]*?\n  }/);assert.ok(code,'missing integrated beforeunload guard');
  for(const flags of [{legacyDirty:true},{pending:true},{profileBusy:true},{sourceBusy:true},{phase:'saving'},{dirty:true},{}]){
    const c=vm.createContext({legacyDirty:false,pending:false,profileBusy:false,sourceBusy:false,...flags,controller:{getState:()=>({phase:flags.phase||'ready',dirty:!!flags.dirty})}});vm.runInContext(code[0],c);let prevented=false;const event={preventDefault(){prevented=true;}};c.protectPageExit(event);assert.equal(prevented,Object.keys(flags).length>0);
  }
});

test('production flushLegacy keeps pending data and displays failure instead of queued success',async()=>{
  const {settleLegacySnapshot}=await import('../src/model/workspace.js');
  const original=newWorkspace();let disk=structuredClone(original),fail=true;
  const controller=createWorkspaceController({browserRepo:{load:async()=>structuredClone(disk),save:async v=>{if(fail)throw Error('disk write failed');disk=structuredClone(v);return {savedAt:v.updatedAt};}},settings:{read:async()=>({mode:'browser'})},directoryFactory:()=>{}});await controller.initialize();
  const profile=original.profiles[0],record={id:1,title:'合成记录',project:'A',workDate:'2026-10-14',hours:1,startTime:'09:00',endTime:'10:00'};
  const map=new Map([['jiepai-user-profiles-v1',JSON.stringify([{id:profile.id,name:profile.name}])],['jiepai-active-profile-v1',profile.id],['jiepai-work-logs-v2:'+profile.id,JSON.stringify([record])]]);
  const classes=new Set(),toast={textContent:'',classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}},detail={textContent:''};
  const cleared=[];
  const c=vm.createContext({map,controller,settleLegacySnapshot,legacyDirty:true,pending:false,toastQueue:['已记录，成功'],sync(){},get:id=>id==='toast'?toast:detail,window:{toastTimer:123},clearTimeout:id=>cleared.push(id),setTimeout(){}});
  vm.runInContext(boot.match(/  async function flushLegacy\(\)[\s\S]*?\n  }/)[0],c);
  await assert.rejects(c.flushLegacy(),/disk write failed/);assert.equal(classes.has('show'),true);assert.deepEqual(cleared,[123]);assert.match(toast.textContent,/保存失败/);assert.doesNotMatch(toast.textContent,/成功|已记录/);assert.match(detail.textContent,/最新修改未保存/);assert.equal(c.toastQueue.length,0);
  assert.equal(controller.getWorkspace().profiles[0].records.length,0);assert.equal(controller.getPending().profiles[0].records.length,1);assert.equal(controller.getState().dirty,true);
  fail=false;await controller.retry();assert.equal(controller.getPending(),null);assert.deepEqual(disk.profiles[0].records,[record]);assert.equal(controller.getState().dirty,false);
});

test('explicit browser-only fallback remains available but never remembers a directory on failed settings write',async()=>{
  const source=settingsModule.createSourceSettings({read:async()=>{throw Error('unavailable');},write:async()=>{throw Error('unavailable');},allowBrowserFallback:true});
  assert.equal((await source.read()).mode,'browser');await source.write({mode:'browser'});await assert.rejects(source.write({mode:'directory',handle:{name:'synthetic'}}),/未切换/);
});

test('failed pending save blocks new data clicks while allowing recovery controls',()=>{
  const functionCode=boot.match(/  function blockWorkspaceMutation\(event\)[\s\S]*?\n  }/);
  const legacy=boot.split('\n').find(l=>l.includes("document.addEventListener('click',event=>{if((pending"));
  for(const recovery of [false,true]){
    let callback;const c=vm.createContext({pending:false,profileBusy:false,sourceBusy:false,controller:{getState:()=>({phase:'error'}),getPending:()=>({revision:1})},document:{addEventListener:(type,fn)=>{callback=fn;}}});
    if(functionCode){vm.runInContext(functionCode[0],c);callback=c.blockWorkspaceMutation;}else vm.runInContext(legacy,c);
    let prevented=false;callback({target:{closest:selector=>recovery&&selector.includes('retry-save')?{}:null},preventDefault(){prevented=true;},stopImmediatePropagation(){}});assert.equal(prevented,!recovery);
  }
});

test('browser flow auto-completion at beforeunload requests protection after creating async dirty data',()=>{
  const source=readFileSync('src/app.js','utf8'),code=source.match(/    function completeFlowOnPageExit\(event\)[\s\S]*?\n    }/)[0];let dirty=false,completed=0;
  const c=vm.createContext({sessionIds:{},workbench:{isDirectory:()=>false,isPending:()=>dirty},completeFlow:()=>{dirty=true;completed++;}});vm.runInContext(code,c);let prevented=false;const event={type:'beforeunload',preventDefault(){prevented=true;}};c.completeFlowOnPageExit(event);assert.equal(completed,1);assert.equal(prevented,true);
});

test('slow checkpoint never makes flow recovery and navigation clicks inaccessible',()=>{
  const code=boot.match(/  function blockWorkspaceMutation\(event\)[\s\S]*?\n  }/)[0];
  const c=vm.createContext({pending:false,profileBusy:false,sourceBusy:false,controller:{getState:()=>({phase:'saving'}),getPending:()=>({sessions:[]})}});vm.runInContext(code,c);
  for(const id of ['open-data-dialog','close-data-dialog','flow-data-recovery','leave-flow-mode','retry-save']){let blocked=false;c.blockWorkspaceMutation({target:{closest:selector=>selector.includes('#'+id)?{}:null},preventDefault(){blocked=true;},stopImmediatePropagation(){}});assert.equal(blocked,false,id+' must remain available');}
});
