import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserRepository} from '../src/storage/browser.js';
import {newWorkspace} from '../src/model/workspace.js';
test('legacy browser migration saves without deleting legacy keys and keeps independent recovery across ordinary saves',async()=>{
  const map=new Map([['jiepai-user-profiles-v1','[{"id":"p","name":"旧用户"}]'],['jiepai-active-profile-v1','p'],['jiepai-work-logs-v2:p','[]']]);
  const local={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
  const repo=createBrowserRepository(null,local),old=await repo.load(),next={...old,revision:1};
  await repo.save(next,0);
  assert.equal(map.get('jiepai-active-profile-v1'),'p');
  const other=newWorkspace();await repo.save(other,1,{replace:true,preserve:true});
  await repo.save({...other,revision:1},0);
  await repo.save(newWorkspace(),1,{replace:true,preserve:true});
  assert.equal((await repo.recovery()).workspaceId,old.workspaceId);
  assert.equal((await repo.recoveries()).length,2);
});
