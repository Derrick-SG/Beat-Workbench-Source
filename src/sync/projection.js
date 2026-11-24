import { timeStatsFor } from '../model/time.js';
import { validateWorkspace } from '../model/workspace.js';
export function profileSnapshot(workspace){
 const p=workspace.profiles.find(p=>p.id===workspace.activeProfileId);return {complete:true,workspaceId:workspace.workspaceId,profileId:p.id,name:p.name,revision:workspace.revision,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,records:structuredClone(p.records),tasks:structuredClone(p.tasks)};
}
export function projectSnapshot(s){
 if(!s||s.complete!==true||typeof s.workspaceId!=='string'||typeof s.profileId!=='string'||!Number.isSafeInteger(s.revision)||s.revision<0||!Array.isArray(s.records)||!Array.isArray(s.tasks)||s.records.length>10000||s.tasks.length>10000)throw Error('需要完整、有效且不超过10000条记录/任务的已保存用户快照');
 if(s.workspaceId.length>200||s.profileId.length>200||s.records.some(r=>String(r.project||'').trim().length>120)||s.tasks.some(t=>String(t.project||'').trim().length>120||String(t.id).length>200))throw Error('同步身份或项目字段超过容量，未截断原数据');
 const allowed=['complete','workspaceId','profileId','name','revision','timeZone','records','tasks'];if(Object.keys(s).some(k=>!allowed.includes(k)))throw Error('快照包含范围外字段');
 validateWorkspace({format:'Beat-Workbench/workspace',schemaVersion:1,workspaceId:s.workspaceId,revision:s.revision,updatedAt:new Date().toISOString(),activeProfileId:s.profileId,profiles:[{id:s.profileId,name:s.name,avatar:null,records:s.records,tasks:s.tasks}],sessions:[],settledSessionIds:[]});
 const scope=[s.workspaceId,s.profileId],key=(type,id)=>JSON.stringify([...scope,type,id]),projects=new Map();
 const bucket=item=>JSON.stringify([!String(item.project||'').trim()||(!!item.flowProjectUnassigned&&String(item.project).trim()==='未分类')?'system':'named',String(item.project||'').trim()||'未分类']);
 for(const item of [...s.records,...s.tasks]){const b=bucket(item);if(!projects.has(b))projects.set(b,{type:'project',key:key('project',b),data:{name:JSON.parse(b)[1],system:JSON.parse(b)[0]==='system',hours:0,tasks:0,completed:0}});}
 const stats=timeStatsFor(s.records.map(r=>({...r,project:bucket(r)})));for(const [b,e] of projects)e.data.hours=stats.projectHours[b]||0;
 for(const t of s.tasks){const p=projects.get(bucket(t));p.data.tasks++;if(t.completed)p.data.completed++;}
 return [...projects.values(),...s.tasks.map(t=>({type:'task',key:key('task',t.id),projectKey:projects.get(bucket(t)).key,data:structuredClone(t)})),...s.records.map(r=>({type:'record',key:key('record',String(r.id)),projectKey:projects.get(bucket(r)).key,data:structuredClone(r)}))];
}
export function snapshotCounts(s){const es=projectSnapshot(s);return {projects:es.filter(e=>e.type==='project').length,tasks:s.tasks.length,records:s.records.length};}
