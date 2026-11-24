import test from 'node:test';
import assert from 'node:assert/strict';
import {newWorkspace} from '../src/model/workspace.js';
test('production legacy snapshot settlement never appends a second log for a settled session',async()=>{
  const {settleLegacySnapshot}=await import('../src/model/workspace.js');
  const w=newWorkspace(),p=w.profiles[0];
  const record={id:1,sessionId:'s',workDate:'2026-10-09',title:'测试',project:'A',hours:1,startTime:'09:00',endTime:'10:00'};
  const first=settleLegacySnapshot(w,[{...p,records:[record]}],p.id);
  const retry=settleLegacySnapshot(first,[{...p,records:[record,{...record,id:2}]}],p.id);
  assert.equal(retry.profiles[0].records.length,1);assert.deepEqual(retry.settledSessionIds,['s']);
});
