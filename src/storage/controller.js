import {validateWorkspace,newWorkspace,storageError} from '../model/workspace.js';
export function createWorkspaceController({browserRepo,settings,directoryFactory,onState=()=>{},validateLoaded=async w=>w,saveTimeoutMs=15000,maxQueuedCommits=8}) {
  let inFlight=null,queued=0,lastRequest=Promise.resolve();
  let workspace=null,repo=browserRepo,source={mode:'browser'},tail=Promise.resolve(),generation=0,pending=null;
  let state={mode:'browser',phase:'resolving',dirty:false};
  const savedListeners=new Set();
  const emit=patch=>{state={...state,...patch};onState({...state});if(patch.phase==='ready'&&workspace){const saved=workspace;for(const listener of savedListeners)setTimeout(()=>{try{Promise.resolve(listener(structuredClone(saved))).catch(()=>{});}catch{}},0);}};
  const clone=()=>workspace?structuredClone(workspace):null;
  async function initialize(){
    if(inFlight||queued)throw storageError('busy','文件写入仍在进行，请先导出副本，完成后重试');
    if(pending)throw storageError('busy','尚未保存的副本待核对，请先重试或导出');
    generation++;
    emit({phase:'loading'});
    try{
      source=await settings.read();
      if(source.mode==='directory'){
        emit({mode:'directory',directoryName:source.handle.name});repo=directoryFactory(source.handle);
        workspace=await repo.load();if(!workspace)throw storageError('missing','已选文件夹缺少工作台文件');
      }else{workspace=await browserRepo.load();if(!workspace)workspace=newWorkspace();}
      workspace=await validateLoaded(workspace);emit({phase:'ready',lastReadAt:new Date().toISOString(),error:null});
    }catch(e){workspace=null;emit({phase:'reconnect',error:e.message});}
  }
  function commit(update,options={}){
    if(inFlight||(pending&&!options.retryCandidate))return Promise.reject(storageError('busy','文件写入仍在进行或尚未核对，请先重试或导出'));
    if(queued>=maxQueuedCommits)return Promise.reject(storageError('busy','保存队列已满，请等待或导出副本'));
    const captured=generation,token={expired:false};queued++;
    let rejectDeadline;
    const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
    const timer=setTimeout(()=>{token.expired=true;if(inFlight===token)emit({phase:'stalled',dirty:true,error:'保存等待超时，写入可能仍在进行；已禁止新写入，请导出副本，完成后重试核对。'});rejectDeadline(storageError('timeout','保存等待超时，写入可能仍在进行；请导出副本，完成后重试核对'));},saveTimeoutMs);
    const operation=tail.then(async()=>{
      if(token.expired)throw storageError('timeout','排队保存等待超时，未执行新写入');
      if(captured!==generation||!workspace||(pending&&!options.retryCandidate)||['reconnect','conflict'].includes(state.phase))throw storageError('conflict','数据来源已变化、尚未连接或存在待重试修改');
      const candidate=options.retryCandidate?validateWorkspace(options.retryCandidate):validateWorkspace(update(clone()));if(!options.retryCandidate){candidate.revision=workspace.revision+1;candidate.updatedAt=new Date().toISOString();}pending=candidate;inFlight=token;
      emit({phase:'saving',dirty:true,error:null});
      try{
        const current=await repo.load();
        if(token.expired||captured!==generation)throw storageError('timeout','读取等待已超时，未启动后续文件写入；请重试核对');
        if(options.retryCandidate&&current&&JSON.stringify(current)===JSON.stringify(candidate)){if(token.expired||captured!==generation)throw storageError('timeout','核对等待超时，请再次重试');workspace=current;pending=null;emit({phase:'ready',dirty:false,error:null,lastSavedAt:current.updatedAt});return {savedAt:current.updatedAt};}
        if(current&&(current.workspaceId!==workspace.workspaceId||current.revision!==workspace.revision||JSON.stringify(current)!==JSON.stringify(workspace)))throw storageError('conflict','数据已在其他位置修改，已停止自动保存');
        const receipt=await repo.save(candidate,current?.revision??null);
        if(captured!==generation)throw storageError('conflict','来源已变化，迟到写入不激活旧工作区');
        if(token.expired)throw storageError('timeout','超时写入已返回，请重试核对保存副本；未自动激活');
        workspace=candidate;pending=null;emit({phase:'ready',dirty:false,lastSavedAt:receipt.savedAt,error:null});return receipt;
      }catch(e){if(captured===generation)emit({phase:e.code==='conflict'?'conflict':'error',dirty:true,error:e.message});throw e;}
      finally{if(inFlight===token)inFlight=null;}
    }).finally(()=>{queued--;clearTimeout(timer);});
    tail=operation.catch(()=>{});lastRequest=Promise.race([operation,deadline]);return lastRequest;
  }
  async function previewDirectory(handle){
    if(inFlight||queued)throw storageError('busy','文件写入仍在进行，请先导出副本');
    await tail;const target=directoryFactory(handle),raw=await target.load(),value=raw?await validateLoaded(raw):null;
    return {handle,repo:target,kind:value?'existing':'empty',workspace:value,fingerprint:JSON.stringify(raw),summary:value?summary(value):summary(workspace)};
  }
  async function migrateDirectory(preview,confirmation){return activateDirectory(preview,confirmation,true);}
  async function activateDirectory(preview,confirmation,migrate=false){
    if(!confirmation)return;if(inFlight||queued)throw storageError('busy','文件写入仍在进行，请先导出副本');await tail;
    if(pending)throw Error('请先重试保存或导出待保存副本');
    if(migrate && source.mode==='directory' && source.handle.isSameEntry && await source.handle.isSameEntry(preview.handle))return;
    const fresh=await preview.repo.load();
    if(JSON.stringify(fresh)!==preview.fingerprint)throw storageError('conflict',migrate&&fresh?'目标文件夹已出现工作台数据，迁移未执行':'文件夹数据已变化，请重新选择并确认摘要');
    if(migrate && fresh)throw storageError('occupied','此文件夹已有工作台数据，未迁移、合并或覆盖。请选择新的空文件夹。');
    let next=fresh?await validateLoaded(fresh):null;
    const originalState={...state};
    try{
      if(!next){next=clone();if(!next)throw Error('没有可迁移的数据');if(migrate)emit({phase:'migrating',error:null});await preview.repo.save(next,null);if(migrate)emit({phase:'verifying'});const check=await preview.repo.load();if(JSON.stringify(check)!==JSON.stringify(next))throw Error('迁移重新读取验证失败');}
      await settings.write({mode:'directory',handle:preview.handle});
    }catch(e){if(migrate){emit({...originalState,error:'迁移未完成，目标可能已生成副本，尚未切换。请重新检查目标或导出当前副本。'+e.message});throw Error(state.error);}throw e;}
    generation++;source={mode:'directory',handle:preview.handle};repo=preview.repo;workspace=next;pending=null;emit({mode:'directory',directoryName:preview.handle.name,phase:'ready',dirty:false,lastReadAt:new Date().toISOString(),error:null});
  }
  async function returnToBrowser(confirmation){
    if(!confirmation)return;if(inFlight||queued)throw storageError('busy','文件写入仍在进行，请先导出副本');await tail;if(pending)throw Error('请先重试保存或导出待保存副本');
    const prior=await browserRepo.load();
    await browserRepo.save(clone(),prior?.revision??null,{replace:true,preserve:true,recovery:prior});
    await settings.write({mode:'browser'});generation++;repo=browserRepo;source={mode:'browser'};emit({mode:'browser',directoryName:null,phase:'ready',dirty:false,lastSavedAt:workspace.updatedAt,error:null});
  }
  async function useOriginalBrowserData(confirmation,create=false){
    if(!confirmation)return;if(inFlight||queued)throw storageError('busy','文件写入仍在进行，请先导出副本');await tail;let value=await browserRepo.load();
    if(!value && !create)throw Error('没有可读取的浏览器副本，请明确创建工作区或导入备份');
    if(!value){value=newWorkspace();await browserRepo.save(value,null);}
    value=await validateLoaded(value);
    await settings.write({mode:'browser'});generation++;workspace=value;repo=browserRepo;source={mode:'browser'};pending=null;emit({mode:'browser',directoryName:null,phase:'ready',dirty:false,lastReadAt:new Date().toISOString(),error:null});
  }
  async function retry(){
    if(inFlight||queued)throw storageError('busy','文件写入仍在进行，不能并发重试；请先导出副本');
    if(!pending){await initialize();return;}
    return commit(()=>{}, {retryCandidate:structuredClone(pending)});
  }
  return {subscribeSaved:listener=>{savedListeners.add(listener);return ()=>savedListeners.delete(listener);},initialize,isWriting:()=>!!inFlight||queued>0,getWorkspace:clone,getPending:()=>pending?structuredClone(pending):null,getState:()=>({...state}),getSource:()=>source,commit,flush:()=>lastRequest,previewDirectory,activateDirectory,migrateDirectory,returnToBrowser,useOriginalBrowserData,retry,getBrowserSnapshot:()=>browserRepo.load()};
}
export function summary(w){return w?`${w.profiles.length} 个工作区 / ${w.profiles.reduce((n,p)=>n+p.records.length,0)} 条记录`:'无数据';}
