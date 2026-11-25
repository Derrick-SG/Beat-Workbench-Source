import { recordsInRange, segmentHours, splitTimeSegments, timeStatsFor as sharedTimeStatsFor } from '../src/model/time.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {parseProfileBackup,makeProfileBackup} from '../src/model/workspace.js';

// Execute unchanged production functions; substitute only browser I/O/UI boundaries.
function harness() {
  const source = readFileSync('src/app.js', 'utf8');
  const names = ['normalizeCategory', 'normalizeTask', 'normalizeTasks', 'normalizeImportedRecords', 'uniqueProfileName', 'importBackup', 'exportBackup', 'durationHours', 'minutesFor', 'timeRangeFor', 'timeStatsFor'];
  const functions = names.map(name => {
    const match = source.match(new RegExp('    function ' + name + '\\([\\s\\S]*?\\n    }'));
    assert.ok(match, `Missing production function ${name}`);
    return match[0];
  }).join('\n');
  const storage = new Map([['logs:original', '[{"id":99}]']]);
  const elements = new Map();
  const context = vm.createContext({
    Blob, console, sharedTimeStatsFor, workbench:{controller:{getWorkspace:()=>({workspaceId:'test'})}}, recordsInRange, segmentHours, splitTimeSegments, parseProfileBackup, makeProfileBackup, validateAvatar:async value=>value, flowStartedAt:null,meetingStartedAt:null,taskTracking:null,meetingDraft:null, profiles: [{ id: 'original', name: '原用户' }], activeProfileId: 'original', logs: [{ id: 99 }], tasks: [],
    window: { appStorage: { setItem: (key, value) => storage.set(key, value) } },
    profileDataKey: id => 'logs:' + id, profileTasksKey: id => 'tasks:' + id,
    today: () => '2026-10-08',
    get: id => { if (!elements.has(id)) elements.set(id, { value: '' }); return elements.get(id); },
    resetReportEditors() {}, resetWorkForm() {}, render() {}, renderProfiles() {},
    persistProfiles() {}, toast(message) { context.lastToast = message; },
    currentProfile() { return context.profiles.find(p => p.id === context.activeProfileId); },
    downloadBlob(blob, filename) { context.download = { blob, filename }; },
    FileReader: class { readAsText(file) { this.result = file.text; context.importDone=this.onload(); } }
  });
  vm.runInContext(functions, context);
  context.storage = storage;
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
const record = { id: 7, workDate: '2026-09-22', title: '设计 <检查> & "交付"', project: '项目A', category: '会议讨论', hours: 1.5, progress: 60, startTime: '09:00', endTime: '10:30', outcome: '成果\n第二行', nextStep: '继续', painPoint: '问题', painSolution: '方案', painStatus: '未解决', painResponse: '跟进', meetingContent: '会议纪要' };
const task = { id: 'task-1', project: '项目A', text: '确认方案', completed: true, createdAt: '2026-09-22T00:00:00Z', completedAt: '2026-09-22T01:00:00Z', source: '会议', batchId: 'batch-1' };

test('v3 backup imports independently and exports/reimports complete supported fields', async () => {
  const c = harness();
  c.importBackup({ name: 'backup.json', text: JSON.stringify({ app: '节拍工作台', version: 3, profile: {name: '原用户'}, records: [record], tasks: [task] }) }); await c.importDone;
  assert.equal(c.profiles.length, 2);
  assert.notEqual(c.activeProfileId, 'original');
  assert.notEqual(c.profiles[1].name, '原用户');
  assert.equal(c.storage.get('logs:original'), '[{"id":99}]');
  assert.deepEqual(plain(c.logs), [record]);
  assert.deepEqual(plain(c.tasks), [task]);
  c.exportBackup();
  const backup = JSON.parse(await c.download.blob.text());
  assert.equal(backup.version, 5);
  assert.deepEqual(backup.records, [record]);
  assert.deepEqual(backup.tasks, [task]);
  const next = harness();
  next.importBackup({ name: 'roundtrip.json', text: JSON.stringify(backup) }); await next.importDone;
  assert.deepEqual(plain(next.logs), [record]);
  assert.deepEqual(plain(next.tasks), [task]);
});

test('legacy arrays normalize old categories and preserve original profile', async () => {
  const c = harness();
  c.importBackup({ name: 'legacy.json', text: JSON.stringify([{ ...record, category: '沟通协作' }]) }); await c.importDone;
  assert.deepEqual(plain(c.logs), [record]);
  assert.deepEqual(plain(c.tasks), []);
  assert.equal(c.profiles.length, 2);
  assert.equal(c.storage.get('logs:original'), '[{"id":99}]');
});

test('empty records import; malformed inputs leave the selected profile untouched', async () => {
  for (const text of ['{', 'null', '{}', '{"records":[null]}']) {
    const c = harness();
    c.importBackup({ name: 'bad.json', text }); await c.importDone;
    assert.equal(c.activeProfileId, 'original');
    assert.equal(c.profiles.length, 1);
    assert.deepEqual(plain(c.logs), [{id:99}]);
    assert.match(c.lastToast, /导入失败/);
  }
  const c = harness();
  c.importBackup({ name: 'empty.json', text: '{"records":[]}' }); await c.importDone;
  assert.equal(c.profiles.length, 2);
  assert.deepEqual(plain(c.logs), []);
});

test('normalization retains original limits and duplicate ID repair', () => {
  const c = harness();
  const result = c.normalizeImportedRecords([{...record, outcome: '长'.repeat(5001), progress: 999}, record]);
  assert.equal(result[0].outcome.length, 5000);
  assert.equal(result[0].progress, 100);
  assert.notEqual(result[0].id, result[1].id);
  assert.equal(c.normalizeTasks([{...task, text: '字'.repeat(241)}])[0].text.length, 240);
});

test('overlaps count once and shared project time is apportioned; overnight duration stays intact', () => {
  const c = harness();
  assert.equal(c.durationHours('23:30', '00:30'), 1);
  assert.equal(c.durationHours('09:00', '09:00'), 24);
  const result = c.timeStatsFor([
    {...record, project:'A', startTime:'09:00', endTime:'11:00'},
    {...record, project:'A', startTime:'09:30', endTime:'10:30'},
    {...record, project:'B', startTime:'10:00', endTime:'12:00'}
  ]);
  assert.deepEqual(plain(result), {total:3, projectHours:{A:1.5, B:1.5}});
  const start=new Date('2026-10-09T09:00:00').getTime();
  const segmented={...record,workDate:'2026-10-09',timeSegments:[{start,end:start+15000},{start:start+3615000,end:start+3630000}]};
  assert.equal(c.timeStatsFor([segmented]).total,30/3600);
});

test('multi-day segmented flow backup roundtrip retains duration and statistics',async()=>{
  const c=harness(),start=new Date('2026-10-14T23:30:00').getTime();
  const long={...record,hours:25,workDate:'2026-10-14',startTime:'23:30',endTime:'00:30',timeSegments:splitTimeSegments([{start,end:start+25*3600000}])};
  c.importBackup({name:'synthetic-long.json',text:JSON.stringify({version:4,profile:{name:'合成'},records:[long],tasks:[]})});await c.importDone;
  assert.equal(c.logs[0].hours,25);assert.equal(c.timeStatsFor(c.logs).total,25);
  c.exportBackup();const backup=JSON.parse(await c.download.blob.text());const next=harness();next.importBackup({name:'roundtrip.json',text:JSON.stringify(backup)});await next.importDone;
  assert.equal(next.logs[0].hours,25);assert.equal(next.timeStatsFor(next.logs).total,25);
});
