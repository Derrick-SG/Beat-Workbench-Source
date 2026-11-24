import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync('src/app.js','utf8');
const fn=name=>source.match(new RegExp('    async function '+name+'\\([^]*?\\n    }'))[0];
function setup(project='P'){
  const nodes=new Map();let calls=0;
  const get=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='flow-project'?project:'',focus(){this.focused=true;}});return nodes.get(id);};
  const c=vm.createContext({get,flowStartedAt:null,flowStartBusy:false,flowFinishBusy:false,flowEntryAwaitingProject:false,switchFeaturePanel(){},updateFlowStartControls(){},updateFlowControls(){},syncFlowProjectTasks(){},startSelectedFlow:async()=>{calls++;}});
  vm.runInContext(fn('startFlowMode'),c);
  return {c,get,calls:()=>calls};
}
test('top flow entry starts a selected project once and leaves running or saving sessions alone',async()=>{
  const {c,calls}=setup();await c.startFlowMode();assert.equal(calls(),1);
  c.flowStartedAt=new Date();await c.startFlowMode();assert.equal(calls(),1);
  c.flowStartedAt=null;c.flowStartBusy=true;await c.startFlowMode();assert.equal(calls(),1);
});
test('top flow entry starts even without a project',async()=>{const {c,calls}=setup('');await c.startFlowMode();assert.equal(calls(),1);});
