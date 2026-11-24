import {uid} from '../model/workspace.js';
export function createSessionManager({controller,clock=()=>performance.now(),setInterval=globalThis.setInterval,clearInterval=globalThis.clearInterval,onError=()=>{}}){
  const running=new Map();let timer=null;
  const elapsed=s=>s.elapsedMs+(running.has(s.id)?Math.max(0,clock()-running.get(s.id)):0);
  async function start(kind,profileId,draft){
    const w=controller.getWorkspace(),id=uid();
    await controller.commit(v=>{v.sessions.push({id,workspaceId:w.workspaceId,profileId,kind,elapsedMs:0,checkpointAt:new Date().toISOString(),status:'running',draft:structuredClone(draft)});return v;});
    running.set(id,clock());ensureTimer();return id;
  }
  function ensureTimer(){if(!timer)timer=setInterval(()=>checkpoint().catch(onError),15000);}
  async function checkpoint(drafts={}){
    const captures=new Map([...running].map(([id,start])=>[id,Math.max(0,clock()-start)]));
    if(!captures.size)return;
    await controller.commit(w=>{for(const s of w.sessions)if(captures.has(s.id)){s.elapsedMs+=captures.get(s.id);s.checkpointAt=new Date().toISOString();if(drafts[s.kind])s.draft=structuredClone(drafts[s.kind]);}return w;});
    for(const [id,amount] of captures)if(running.has(id))running.set(id,running.get(id)+amount);
  }
  async function restore(id){
    const s=controller.getWorkspace().sessions.find(s=>s.id===id);if(!s)throw Error('计时会话不存在');
    running.set(id,clock());ensureTimer();return structuredClone(s);
  }
  async function discard(id){await controller.commit(w=>{w.sessions=w.sessions.filter(s=>s.id!==id);return w;});running.delete(id);stopIfEmpty();}
  async function complete(id,makeRecord){
    let w=controller.getWorkspace();if(w.settledSessionIds.includes(id))return;
    const s=w.sessions.find(s=>s.id===id);if(!s)throw Error('计时会话不存在');
    const record=makeRecord({sessionId:id,profileId:s.profileId,elapsedMs:elapsed(s),draft:structuredClone(s.draft)});
    await controller.commit(v=>{if(v.settledSessionIds.includes(id))return v;v.profiles.find(p=>p.id===s.profileId).records.push({...record,sessionId:id});v.settledSessionIds.push(id);v.sessions=v.sessions.filter(s=>s.id!==id);return v;});
    running.delete(id);stopIfEmpty();
  }
  function stopIfEmpty(){if(!running.size&&timer){clearInterval(timer);timer=null;}}
  async function pause(){await checkpoint();running.clear();stopIfEmpty();}
  return {start,checkpoint,restore,discard,complete,pause,hasActiveSession:()=>running.size>0};
}

import { splitTimeSegments, segmentHours } from '../model/time.js';
function localDate(ms){const d=new Date(ms);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function localTime(ms){const d=new Date(ms);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
export function createFlowStartIntent(workspaceId,profileId,project,startedAt=Date.now()){
  project=String(project??'').trim();if(project.length>120)throw Error('所属项目不能超过120字');
  if(!Number.isFinite(startedAt)||!Number.isFinite(new Date(startedAt).getTime()))throw Error('开始时间无效');
  return {id:uid(),workspaceId,profileId,project,startedAt};
}
export async function startDurableFlow(controller,intent,metadata={}){
  const pending=controller.getPending();
  if(pending){if(!pending.sessions.some(s=>s.id===intent.id))throw Error('有其他待保存数据，请先重试或导出');await controller.retry();}
  let w=controller.getWorkspace();if(w.workspaceId!==intent.workspaceId)throw Error('数据来源已变化，未开始心流');
  const existing=w.sessions.find(s=>s.id===intent.id);if(existing)return existing;
  if(w.settledSessionIds.includes(intent.id))throw Error('本次心流已结算，不能重复启动');
  if(w.sessions.some(s=>s.kind==='flow'&&s.profileId===intent.profileId))throw Error('上次心流正在按检查点结算，请稍后重试或打开保存状态');
  await controller.commit(value=>{if(value.workspaceId!==intent.workspaceId||!value.profiles.some(p=>p.id===intent.profileId))throw Error('用户或来源已变化');value.sessions.push({id:intent.id,workspaceId:intent.workspaceId,profileId:intent.profileId,kind:'flow',status:'running',elapsedMs:0,checkpointAt:new Date(intent.startedAt).toISOString(),draft:{recoveryPolicy:'checkpoint-end',startedAt:intent.startedAt,project:intent.project,category:metadata.category||'项目推进',tasks:structuredClone(metadata.tasks||[]),segments:[],originDate:localDate(intent.startedAt),originTime:localTime(intent.startedAt)}});return value;});
  return controller.getWorkspace().sessions.find(s=>s.id===intent.id);
}
export function flowStartTime(session){
  const starts=(session.draft.segments||[]).map(s=>s.start).filter(Number.isFinite);
  const value=Number.isFinite(session.draft.startedAt)?session.draft.startedAt:starts.length?Math.min(...starts):Date.parse(session.draft.originDate+'T'+session.draft.originTime+':00');
  if(!Number.isFinite(value))throw Error('旧版心流开始时间无法验证，请导出副本核对');return value;
}
export function validateFlowEnd(session,endAt,now=Date.now()){
  if(!Number.isFinite(endAt)||!Number.isFinite(new Date(endAt).getTime()))throw Error('请填写实际结束日期与时间');
  const start=flowStartTime(session);if(endAt<start)throw Error('结束时间不能早于开始时间');if(endAt===start)throw Error('结束时间必须晚于开始时间，不能生成零时长记录');if(endAt>now)throw Error('结束时间不能晚于当前时间');return endAt;
}
export async function updateDurableFlowProject(controller,sessionId,project){
  project=String(project??'').trim();if(project.length>120)throw Error('所属项目不能超过120字');
  const pending=controller.getPending();
  if(pending){if(!pending.sessions.some(s=>s.id===sessionId))throw Error('有其他待保存数据，请先重试或导出');await controller.retry();}
  await controller.commit(w=>{const session=w.sessions.find(s=>s.id===sessionId&&s.kind==='flow');if(!session)throw Error('心流会话不存在');session.draft.project=project;return w;});
}
export async function settleDurableFlow(controller,sessionId,{endAt,now=Date.now(),segments=null,recordDraft={},draftTasks=[],project}){
  const pending=controller.getPending();
  if(pending){if(!pending.settledSessionIds.includes(sessionId)&&!pending.sessions.some(s=>s.id===sessionId))throw Error('有其他待保存副本，请先重试或导出');await controller.retry();}
  const w=controller.getWorkspace(),already=w.profiles.flatMap(p=>p.records).find(r=>r.sessionId===sessionId);
  if(w.settledSessionIds.includes(sessionId)){if(!already)throw Error('结算标记缺少记录，请导出核对');return already;}
  const session=w.sessions.find(s=>s.id===sessionId&&s.kind==='flow');if(!session)throw Error('待结算心流不存在，请重新读取');
  project=String(project??session.draft.project).trim();if(!project||project.length>120)throw Error('请补选有效所属项目，已计时间仍保留');
  validateFlowEnd(session,endAt,now);const start=flowStartTime(session);
  const actual=splitTimeSegments(segments||[{start,end:endAt}]);
  if(!actual.length||actual.some(s=>s.start<start||s.end>endAt)||!(segmentHours(actual)>0))throw Error('实际工作分段无效');
  await controller.commit(value=>{
    if(value.settledSessionIds.includes(sessionId))return value;
    const found=value.sessions.find(s=>s.id===sessionId&&s.profileId===session.profileId);if(!found)throw Error('会话归属已变化');
    session.draft.project=project;
    const owner=value.profiles.find(p=>p.id===session.profileId);if(!owner)throw Error('原用户不存在');
    let id=Date.now();while(owner.records.some(r=>r.id===id))id++;
    const record={id,workDate:localDate(start),title:recordDraft.title||'心流工作',project:session.draft.project,category:recordDraft.category||session.draft.category||'项目推进',progress:100,outcome:recordDraft.outcome||'心流工作记录',nextStep:'',meetingContent:'',painPoint:'',painSolution:'',painStatus:'已解决',painResponse:'',hours:segmentHours(actual),startTime:localTime(start),endTime:localTime(endAt),sessionId,timeSegments:actual,flowSettlement:recordDraft.flowSettlement||(segments?'segments':'confirmed-end'),...(recordDraft.flowProjectUnassigned?{flowProjectUnassigned:true}:{})};
    owner.records.push(record);
    for(const task of draftTasks.filter(t=>!t.sourceTaskId&&String(t.text||'').trim()))owner.tasks.push({id:uid(),text:String(task.text).trim().slice(0,240),project:session.draft.project,completed:!!task.completed,createdAt:new Date(now).toISOString(),completedAt:task.completed?new Date(now).toISOString():'',source:'心流模式',batchId:sessionId});
    value.sessions=value.sessions.filter(s=>s.id!==sessionId);value.settledSessionIds.push(sessionId);return value;
  });
  return controller.getWorkspace().profiles.find(p=>p.id===session.profileId).records.find(r=>r.sessionId===sessionId);
}
export function checkpointFlowPlan(session,now=Date.now()){
  const start=flowStartTime(session),checkpoint=Date.parse(session.checkpointAt);
  if(!Number.isFinite(checkpoint)||checkpoint<start||checkpoint>now)throw Error('心流检查点时间无法验证，请导出副本核对');
  const saved=session.draft.segments||[];
  if(saved.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<start||s.end>checkpoint||s.end<s.start))throw Error('心流分段超出已保存检查点，请导出副本核对');
  let segments=splitTimeSegments(saved);
  if(!segments.length&&session.elapsedMs>0){
    if(!Number.isFinite(session.elapsedMs)||checkpoint-session.elapsedMs<start)throw Error('旧版心流检查点时长无法验证，请导出副本核对');
    segments=splitTimeSegments([{start:checkpoint-session.elapsedMs,end:checkpoint}]);
  }
  return {start,checkpoint,segments,empty:!segments.length};
}
export async function settleCheckpointFlow(controller,sessionId,now=Date.now()){
  const pending=controller.getPending();
  if(pending){if(!pending.settledSessionIds.includes(sessionId))throw Error('尚有未成功保存的修改；请先处理保存状态，自动结算不会使用未保存检查点');await controller.retry();}
  const w=controller.getWorkspace();
  if(w.settledSessionIds.includes(sessionId)){
    const record=w.profiles.flatMap(p=>p.records).find(r=>r.sessionId===sessionId);
    if(record)return {status:'saved',record};
    if(w.flowClosures?.some(r=>r.sessionId===sessionId))return {status:'empty'};
    throw Error('心流结算标记缺少记录或零时长凭据，请导出副本核对');
  }
  const session=w.sessions.find(s=>s.id===sessionId&&s.kind==='flow');if(!session)return {status:'gone'};
  const plan=checkpointFlowPlan(session,now);
  if(plan.empty){
    await controller.commit(value=>{
      if(value.settledSessionIds.includes(sessionId))return value;
      const found=value.sessions.find(s=>s.id===sessionId&&s.profileId===session.profileId);if(!found)throw Error('心流会话已变化，请重新读取');
      value.flowClosures??=[];value.flowClosures.push({sessionId,profileId:session.profileId,startedAt:plan.start,checkpointAt:session.checkpointAt,elapsedMs:0,reason:'no-positive-checkpoint'});
      value.sessions=value.sessions.filter(s=>s.id!==sessionId);value.settledSessionIds.push(sessionId);return value;
    });return {status:'empty'};
  }
  const unassigned=!String(session.draft.project||'').trim(),project=unassigned?'未分类':String(session.draft.project).trim();
  const record=await settleDurableFlow(controller,sessionId,{endAt:plan.checkpoint,now,segments:plan.segments,project,draftTasks:session.draft.tasks||[],recordDraft:{title:'心流：检查点自动保存',outcome:'按最后成功保存检查点自动结算，不计关闭后的间隔。'+(unassigned?' 项目“未分类”为系统占位，可编辑补充。':''),flowSettlement:'checkpoint',flowProjectUnassigned:unassigned}});
  return {status:'saved',record};
}
