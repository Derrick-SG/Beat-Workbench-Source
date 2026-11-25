import { segmentHours } from './time.js';
export function uid() { return globalThis.crypto?.randomUUID?.() || 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
export function storageError(code, message) { return Object.assign(new Error(message), {code}); }
export function newWorkspace() {
  const id=uid();
  return {format:'Beat-Workbench/workspace',schemaVersion:1,workspaceId:uid(),revision:0,updatedAt:new Date().toISOString(),activeProfileId:id,profiles:[{id,name:'我的工作台',avatar:null,records:[],tasks:[],reportOverrides:{}}],sessions:[],settledSessionIds:[]};
}
const reportKinds=new Set(['day','week','month','year']);
export function reportOverrideKey(kind,start,end){
  if(!reportKinds.has(kind)||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)throw storageError('invalid','报告范围无效');
  return kind+':'+start+':'+end;
}
export function validateReportOverrides(value){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>500)throw storageError('invalid','报告草稿无效');
  for(const [key,entry] of Object.entries(value)){
    const match=/^(day|week|month|year):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(key);
    if(!match||reportOverrideKey(match[1],match[2],match[3])!==key||!entry||typeof entry.text!=='string'||entry.text.length>100000||!['ai','manual'].includes(entry.source)||!Number.isFinite(Date.parse(entry.savedAt)))throw storageError('invalid','报告草稿无效');
  }
  return value;
}
export function aiReportProjection(profile,kind,start,end){
  reportOverrideKey(kind,start,end);
  const items=(profile.records||[]).filter(r=>r.workDate>=start&&r.workDate<=end).map(r=>({
    title:String(r.title||'').slice(0,240),workDate:r.workDate,project:String(r.project||'').slice(0,120),hours:Number(r.hours),outcome:String(r.outcome||'').slice(0,5000),nextStep:String(r.nextStep||'').slice(0,5000),progress:Number(r.progress)||0
  })).sort((a,b)=>a.workDate.localeCompare(b.workDate)||a.title.localeCompare(b.title));
  return {kind,start,end,recordCount:items.length,items};
}
export function validateAvatarShape(avatar) {
  if (avatar == null) return null;
  if (!['image/png','image/jpeg'].includes(avatar.mime) || typeof avatar.dataUrl!=='string' || !avatar.dataUrl.startsWith('data:'+avatar.mime+';base64,') || avatar.dataUrl.length>Math.ceil(200*1024/3)*4+40) throw storageError('invalid','头像数据无效或超过200 KB');
  const raw=avatar.dataUrl.split(',')[1];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw storageError('invalid','头像编码无效');
  const decoded=atob(raw);
  if(avatar.mime==='image/png'?!decoded.startsWith('\x89PNG\r\n\x1a\n'):!decoded.startsWith('\xff\xd8\xff'))throw storageError('invalid','头像不是有效图片字节');
  return avatar;
}
export function validateWorkspace(value) {
  if (!value || value.format!=='Beat-Workbench/workspace') throw storageError('invalid','不是工作台目录数据');
  if (value.schemaVersion!==1) throw storageError('unsupported','不支持此目录数据版本');
  if (typeof value.workspaceId!=='string' || !value.workspaceId || !Number.isSafeInteger(value.revision) || value.revision<0 || !Number.isFinite(Date.parse(value.updatedAt)) || !Array.isArray(value.profiles) || !value.profiles.length || !Array.isArray(value.sessions) || !Array.isArray(value.settledSessionIds)) throw storageError('invalid','工作台结构无效');
  const ids=new Set(), names=new Set();
  if(value.flowClosures!==undefined&&(!Array.isArray(value.flowClosures)||value.flowClosures.some(r=>!r||typeof r.sessionId!=='string'||typeof r.profileId!=='string'||!Number.isFinite(r.startedAt)||!Number.isFinite(Date.parse(r.checkpointAt))||r.elapsedMs!==0||r.reason!=='no-positive-checkpoint')))throw storageError('invalid','心流零时长结束凭据无效');
  for (const p of value.profiles) {
    if (!p || typeof p.id!=='string' || !p.id || ids.has(p.id) || typeof p.name!=='string' || !p.name.trim() || p.name.length>30 || names.has(p.name) || !Array.isArray(p.records) || !Array.isArray(p.tasks)) throw storageError('invalid','工作区资料无效或重复');
    validateAvatarShape(p.avatar);validateReportOverrides(p.reportOverrides); ids.add(p.id); names.add(p.name);
    const recordIds=new Set(),taskIds=new Set();
    for(const r of p.records){
      if(!r || !Number.isSafeInteger(r.id) || recordIds.has(r.id) || typeof r.workDate!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.workDate) || !Number.isFinite(Date.parse(r.workDate)) || new Date(r.workDate+'T12:00:00Z').toISOString().slice(0,10)!==r.workDate || typeof r.title!=='string' || typeof r.project!=='string' || !Number.isFinite(r.hours) || r.hours<=0 || (r.hours>24 && (!Array.isArray(r.timeSegments)||!r.timeSegments.length||Math.abs(segmentHours(r.timeSegments)-r.hours)>1e-7)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.endTime))throw storageError('invalid','记录ID、日期、时段或工时无效');
      recordIds.add(r.id);
      if(Object.prototype.hasOwnProperty.call(r,'_ranges'))throw storageError('invalid','记录含保留的统计字段');
    }
    for(const t of p.tasks){if(!t||typeof t.id!=='string'||taskIds.has(t.id)||typeof t.text!=='string'||typeof t.project!=='string'||typeof t.completed!=='boolean')throw storageError('invalid','任务数据无效');taskIds.add(t.id);}
    for(const r of p.records)if(r.timeSegments && (!Array.isArray(r.timeSegments)||r.timeSegments.length>10000||r.timeSegments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.end<s.start||s.end-s.start>86400000)))throw storageError('invalid','工作分段无效');
  }
  if (!ids.has(value.activeProfileId)) throw storageError('invalid','当前工作区不存在');
  const sessions=new Set();
  for (const s of value.sessions) {
    if (!s || typeof s.id!=='string' || sessions.has(s.id) || s.workspaceId!==value.workspaceId || !ids.has(s.profileId) || !['flow','meeting','task'].includes(s.kind) || !['running','paused'].includes(s.status) || !Number.isFinite(s.elapsedMs) || s.elapsedMs<0 || !Number.isFinite(Date.parse(s.checkpointAt)) || !s.draft || typeof s.draft!=='object') throw storageError('invalid','计时恢复数据无效');
    if(typeof s.draft.project!=='string'||typeof s.draft.originDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s.draft.originDate)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.draft.originTime)||!Array.isArray(s.draft.segments)||s.draft.segments.some(t=>!Number.isFinite(t.start)||!Number.isFinite(t.end)||t.end<t.start)||(s.draft.tasks&&(!Array.isArray(s.draft.tasks)||s.draft.tasks.some(t=>!t||typeof t.text!=='string'))))throw storageError('invalid','计时草稿或工作分段损坏');
    sessions.add(s.id);
  }
  if (value.settledSessionIds.some(id=>typeof id!=='string') || new Set(value.settledSessionIds).size!==value.settledSessionIds.length) throw storageError('invalid','会话去重数据无效');
  return structuredClone(value);
}
export function readLegacyBrowser(storage) {
  const read=(key,fallback)=>{const raw=storage.getItem(key); return raw===null?fallback:JSON.parse(raw);};
  const profiles=read('jiepai-user-profiles-v1',null);
  if (!profiles) {
    const records=read('jiepai-work-logs-v1',null);
    if (records===null) return null;
    if (!Array.isArray(records)) throw storageError('invalid','旧浏览器记录损坏');
    const w=newWorkspace(); w.profiles[0].records=records; return validateWorkspace(w);
  }
  if (!Array.isArray(profiles) || !profiles.length) throw storageError('invalid','旧浏览器用户数据损坏');
  const w=newWorkspace();
  w.profiles=profiles.map(p=>({...p,avatar:p.avatar||null,records:read('jiepai-work-logs-v2:'+p.id,[]),tasks:read('jiepai-project-tasks-v1:'+p.id,[])}));
  w.activeProfileId=storage.getItem('jiepai-active-profile-v1') || profiles[0].id;
  return validateWorkspace(w);
}
export function parseProfileBackup(value) {
  if (Array.isArray(value)) return {name:'恢复的工作台',avatar:null,records:value,tasks:[]};
  if (!value || value.format || !Array.isArray(value.records) || ![undefined,3,4,5].includes(value.version)) throw storageError('invalid','备份格式或版本不支持');
  const avatar=value.version===4?validateAvatarShape(value.profile?.avatar):null;
  return {name:String(value.profile?.name||'恢复的工作台'),avatar:value.version===5?validateAvatarShape(value.profile?.avatar):avatar,records:value.records,tasks:Array.isArray(value.tasks)?value.tasks:[],...(value.version===5?{reportOverrides:structuredClone(validateReportOverrides(value.reportOverrides))}:{})};
}
export function makeProfileBackup(profile) {return {app:'节拍工作台',version:5,exportedAt:new Date().toISOString(),profile:{name:profile.name,avatar:profile.avatar||null},records:structuredClone(profile.records),tasks:structuredClone(profile.tasks),reportOverrides:structuredClone(validateReportOverrides(profile.reportOverrides))};}
export function settleLegacySnapshot(workspace,profiles,activeProfileId){
  const w=structuredClone(workspace),existing=new Map(w.profiles.flatMap(p=>p.records.filter(r=>r.sessionId).map(r=>[r.sessionId,r.id]))),seen=new Set(),settled=new Set(w.settledSessionIds);
  const priorProfiles=new Map(w.profiles.map(p=>[p.id,p]));
  w.profiles=structuredClone(profiles).map(p=>({...p,reportOverrides:structuredClone(validateReportOverrides(p.reportOverrides??priorProfiles.get(p.id)?.reportOverrides)),records:p.records.filter(r=>{
    if(!r.sessionId)return true;
    if(seen.has(r.sessionId))return false;seen.add(r.sessionId);
    if(settled.has(r.sessionId)&&existing.get(r.sessionId)!==r.id)return false;
    settled.add(r.sessionId);return true;
  })}));
  w.activeProfileId=activeProfileId;w.settledSessionIds=[...settled];w.sessions=w.sessions.filter(s=>!settled.has(s.id));return w;
}
