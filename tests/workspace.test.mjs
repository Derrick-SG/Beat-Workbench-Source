import test from 'node:test';
import assert from 'node:assert/strict';

test('workspace and backups distinguish invalid data from missing data and retain legacy compatibility', async () => {
  const m = await import('../src/model/workspace.js');
  const w = m.newWorkspace();
  assert.equal(m.validateWorkspace(w).schemaVersion,1);
  for (const bad of [null,{}, {...w,schemaVersion:99},{...w,activeProfileId:'missing'}]) assert.throws(()=>m.validateWorkspace(bad));
  const profile={id:'p',name:'姓名',avatar:null,records:[{id:7,hours:1.5}],tasks:[]};
  assert.deepEqual(m.parseProfileBackup(m.makeProfileBackup(profile)), {name:'姓名',avatar:null,records:profile.records,tasks:[],reportOverrides:{}});
  assert.equal(m.parseProfileBackup({version:3,profile:{name:'旧用户'},records:[],tasks:[]}).avatar,null);
  assert.deepEqual(m.parseProfileBackup([]).records,[]);
  assert.throws(()=>m.parseProfileBackup({version:99,records:[]}));
  assert.throws(()=>m.parseProfileBackup({format:'Beat-Workbench/workspace',records:[]}));
  const malformed=m.newWorkspace();malformed.profiles[0].records=[{hours:1}];assert.throws(()=>m.validateWorkspace(malformed));
  assert.throws(()=>m.validateAvatarShape({mime:'image/png',dataUrl:'data:image/png;base64,YmFk'}));
  const map=new Map([['jiepai-user-profiles-v1','broken']]);
  assert.throws(()=>m.readLegacyBrowser({getItem:k=>map.get(k)??null}));
});

test('report overrides survive workspace validation, legacy writes and profile backups',async()=>{
  const m=await import('../src/model/workspace.js');
  const w=m.newWorkspace(),p=w.profiles[0],key=m.reportOverrideKey('week','2026-11-23','2026-11-29');
  p.reportOverrides[key]={text:'审核后的总结',source:'ai',savedAt:'2026-11-24T00:00:00.000Z'};
  assert.equal(m.validateWorkspace(w).profiles[0].reportOverrides[key].text,'审核后的总结');
  const oldProfile={id:p.id,name:p.name,avatar:null,records:[],tasks:[]};
  assert.equal(m.settleLegacySnapshot(w,[oldProfile],p.id).profiles[0].reportOverrides[key].text,'审核后的总结');
  assert.equal(m.parseProfileBackup(m.makeProfileBackup(p)).reportOverrides[key].text,'审核后的总结');
  p.reportOverrides[key].source='unknown';assert.throws(()=>m.validateWorkspace(w));
});

test('AI report projection includes only selected active profile saved fields',async()=>{
  const {aiReportProjection}=await import('../src/model/workspace.js');
  const profile={records:[{workDate:'2026-11-24',title:'任务',project:'项目',hours:2,outcome:'产出',nextStep:'下一步',progress:60,meetingContent:'私密会议正文',painPoint:'私密痛点',avatar:'私密头像'}, {workDate:'2026-11-25',title:'范围外',hours:1}]};
  const report=aiReportProjection(profile,'day','2026-11-24','2026-11-24');
  assert.equal(report.recordCount,1);
  assert.deepEqual(Object.keys(report.items[0]),['title','workDate','project','hours','outcome','nextStep','progress']);
  assert.equal(JSON.stringify(report).includes('私密'),false);
});
