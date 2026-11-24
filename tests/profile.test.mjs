import test from 'node:test';
import assert from 'node:assert/strict';

test('name edits preserve identity, reject collisions and only commit on persistence success', async () => {
  const { validateName, saveProfileDraft } = await import('../src/profile/editor.js');
  const profiles = [{id:'a',name:'甲',avatar:null,records:[{id:1}],tasks:[]},{id:'b',name:'乙',avatar:null,records:[],tasks:[]}];
  assert.equal(validateName(' 新名 ', profiles, 'a'), '新名');
  for (const name of ['', '乙', '字'.repeat(31)]) assert.throws(() => validateName(name,profiles,'a'));
  let workspace = {profiles};
  const controller = {getWorkspace:()=>workspace, commit:async () => {throw Error('disk failed');}};
  await assert.rejects(saveProfileDraft(controller,'a',{name:'新名',avatar:null}));
  assert.equal(workspace.profiles[0].name,'甲');
  controller.commit = async update => {workspace=update(structuredClone(workspace)); return {revision:1};};
  const avatar={mime:'image/png',dataUrl:'synthetic-avatar'};
  await saveProfileDraft(controller,'a',{name:'新名',avatar});
  assert.equal(workspace.profiles.length,2);assert.deepEqual(workspace.profiles[0].avatar,avatar);assert.deepEqual(workspace.profiles[1],profiles[1]);
  assert.equal(workspace.profiles[0].id,'a');
  assert.deepEqual(workspace.profiles[0].records,[{id:1}]);
});
