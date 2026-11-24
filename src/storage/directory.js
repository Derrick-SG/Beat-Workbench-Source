import { validateWorkspace, storageError } from '../model/workspace.js';
export function detectDirectorySupport() {return !!(globalThis.isSecureContext && globalThis.showDirectoryPicker && globalThis.indexedDB && globalThis.navigator?.locks && location.protocol!=='file:');}
export function pickDirectory() {return globalThis.showDirectoryPicker({mode:'readwrite',id:'beat-workbench'});}
export function queryAccess(handle) {return handle.queryPermission({mode:'readwrite'});}
export async function requestAccess(handle) {return (await handle.requestPermission({mode:'readwrite'}))==='granted';}
function fileFailure(error,name,stage,operation){
  const steps={handle:'获取文件句柄',getFile:'获取文件快照',text:'读取文件内容',createWritable:'准备写入',write:'写入内容',close:'关闭并提交写入'};
  const operations={load:'读取工作台',preflight:'保存前核对',backup:'保存上一份快照',recheck:'主文件写入前核对',primary:'保存主文件',verify:'写后回读验证',previous:'读取上一份快照',repair:'恢复快照',damage:'保留损坏原件'};
  const detail=['NotAllowedError','SecurityError'].includes(error.name)?'权限不足，请重新授权':['InvalidStateError','NotReadableError'].includes(error.name)?'文件状态已变化或暂时不可读，请稍后重试':'操作未完成，请重试或导出副本';
  return Object.assign(storageError('io',(operations[operation]||operation)+'失败：'+name+' · '+steps[stage]+'（'+(error.name||'Error')+'）。'+detail+'；待保存副本仍保留。'),{name:error.name||'Error',cause:error,directoryFile:name,directoryStage:stage,directoryOperation:operation});
}
async function read(handle,name,operation='load') {
  for(let attempt=0;attempt<2;attempt++){
    let stage='handle';
    try{
      const fileHandle=await handle.getFileHandle(name);stage='getFile';const file=await fileHandle.getFile();stage='text';return await file.text();
    }catch(e){
      if(e.name==='NotFoundError'&&stage==='handle'&&attempt===0)return null;
      if(attempt===0&&['InvalidStateError','NotReadableError'].includes(e.name))continue;
      throw fileFailure(e,name,stage,operation);
    }
  }
}
function decode(raw) {
  try {return validateWorkspace(JSON.parse(raw));} catch(e){throw e.code?e:storageError('invalid','工作台文件为空白或损坏，未作任何覆盖');}
}
async function write(handle,name,text,operation='primary') {
  let stream,stage='handle';
  try {const fileHandle=await handle.getFileHandle(name,{create:true});stage='createWritable';stream=await fileHandle.createWritable();stage='write';await stream.write(text);stage='close';await stream.close();}
  catch(e){if(stream)try{await stream.abort();}catch{}throw fileFailure(e,name,stage,operation);}
}
export async function readPreviousSnapshot(handle) {
  const raw=await read(handle,'beat-workbench.previous.json','previous');
  if(raw===null)throw storageError('missing','没有上一份快照');return decode(raw);
}
export function createDirectoryRepository(handle) {
  let fingerprint=null, tail=Promise.resolve();
  async function load(){const raw=await read(handle,'beat-workbench.workspace.json');const w=raw===null?null:decode(raw);fingerprint=raw;return w;}
  function save(candidate,expectedRevision){
    const operation=tail.then(async()=>{
      validateWorkspace(candidate);
      const raw=await read(handle,'beat-workbench.workspace.json','preflight');
      const prior=raw===null?null:decode(raw);
      if((prior?.revision??null)!==expectedRevision || raw!==fingerprint)throw storageError('conflict','文件已在其他位置修改，已停止自动保存');
      if(raw!==null)await write(handle,'beat-workbench.previous.json',raw,'backup');
      if(await read(handle,'beat-workbench.workspace.json','recheck')!==raw)throw storageError('conflict','主文件已在备份期间被其他位置修改，未继续写入');
      const serialized=JSON.stringify(candidate);
      await write(handle,'beat-workbench.workspace.json',serialized,'primary');
      const verified=await read(handle,'beat-workbench.workspace.json','verify');
      if(verified!==serialized)throw storageError('io','文件重新读取验证失败');
      decode(verified); fingerprint=verified;
      return {workspaceId:candidate.workspaceId,revision:candidate.revision,savedAt:candidate.updatedAt};
    });
    tail=operation.catch(()=>{});return operation;
  }
  async function restorePrevious(confirmation){
    if(!confirmation)return;await tail;
    const candidate=await readPreviousSnapshot(handle),raw=await read(handle,'beat-workbench.workspace.json');
    if(raw!==null){
      const existingDamage=await read(handle,'beat-workbench.damaged.json');
      if(existingDamage===null){
        const originalFile=await (await handle.getFileHandle('beat-workbench.workspace.json')).getFile();
        const originalBytes=originalFile.arrayBuffer?new Uint8Array(await originalFile.arrayBuffer()):raw;
        await write(handle,'beat-workbench.damaged.json',originalBytes,'damage');
      }
    }
    candidate.revision++;candidate.updatedAt=new Date().toISOString();const serialized=JSON.stringify(candidate);
    await write(handle,'beat-workbench.workspace.json',serialized,'repair');
    if(await read(handle,'beat-workbench.workspace.json','verify')!==serialized)throw storageError('io','恢复重新读取验证失败');
    fingerprint=serialized;return candidate;
  }
  return {load,save,restorePrevious,flush:()=>tail,handle};
}
