import test from 'node:test';
import assert from 'node:assert/strict';

test('workspace and backups distinguish invalid data from missing data and retain legacy compatibility', async () => {
  const m = await import('../src/model/workspace.js');
  const w = m.newWorkspace();
  assert.equal(m.validateWorkspace(w).schemaVersion,1);
  for (const bad of [null,{}, {...w,schemaVersion:99},{...w,activeProfileId:'missing'}]) assert.throws(()=>m.validateWorkspace(bad));
  const profile={id:'p',name:'姓名',avatar:null,records:[{id:7,hours:1.5}],tasks:[]};
  assert.deepEqual(m.parseProfileBackup(m.makeProfileBackup(profile)), {name:'姓名',avatar:null,records:profile.records,tasks:[]});
  assert.equal(m.parseProfileBackup({version:3,profile:{name:'旧用户'},records:[],tasks:[]}).avatar,null);
  assert.deepEqual(m.parseProfileBackup([]).records,[]);
  assert.throws(()=>m.parseProfileBackup({version:99,records:[]}));
  assert.throws(()=>m.parseProfileBackup({format:'Beat-Workbench/workspace',records:[]}));
  const malformed=m.newWorkspace();malformed.profiles[0].records=[{hours:1}];assert.throws(()=>m.validateWorkspace(malformed));
  assert.throws(()=>m.validateAvatarShape({mime:'image/png',dataUrl:'data:image/png;base64,YmFk'}));
  const map=new Map([['jiepai-user-profiles-v1','broken']]);
  assert.throws(()=>m.readLegacyBrowser({getItem:k=>map.get(k)??null}));
});
