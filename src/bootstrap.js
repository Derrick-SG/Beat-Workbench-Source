import {mountNotionSync} from './sync/notion.js';
import {createBrowserRepository} from './storage/browser.js';
import {createSourceSettings} from './storage/settings.js';
import {createDirectoryRepository,detectDirectorySupport,pickDirectory,requestAccess,readPreviousSnapshot} from './storage/directory.js';
import {createWorkspaceController,summary} from './storage/controller.js';
import {saveProfileDraft} from './profile/editor.js';
import {prepareAvatar,validateAvatar} from './profile/avatar.js';
import {validateWorkspace,newWorkspace,settleLegacySnapshot} from './model/workspace.js';

export function shouldBlockWorkspaceMutation({pending,profileBusy,sourceBusy,phase,hasPendingSnapshot,target}) {
  const busy=pending||profileBusy||sourceBusy||phase==='saving';
  const allowedWhileSaving=target.closest('#open-data-dialog,#close-data-dialog,#flow-data-recovery,#leave-flow-mode,#retry-save,#reconnect-folder,#export-workspace,.directory-choice,.flow-checkpoint-recovery,#meeting-form');
  const allowedWithPendingSnapshot=target.closest('#open-data-dialog,#close-data-dialog,#flow-data-recovery,#leave-flow-mode,#start-flow-session,#complete-flow-session,#flow-form,#meeting-form,.flow-checkpoint-recovery,#retry-save,#export-workspace,#reconnect-folder,#original-browser,#browser-recovery');
  return busy?!allowedWhileSaving:hasPendingSnapshot&&!allowedWithPendingSnapshot;
}

export async function initializeWorkbench(){
  const get=id=>document.getElementById(id);
  let local;try{local=window.localStorage;}catch{local={getItem:()=>null,setItem:()=>{throw Error('浏览器禁止本地存储');}};}
  const browserRepo=createBrowserRepository(globalThis.indexedDB,local);
  let settingsAvailable=true,temporary=false;
  const settings=createSourceSettings({allowBrowserFallback:!globalThis.indexedDB||location.protocol==='file:',onAvailability:available=>{settingsAvailable=available;}});
  const directoryFactory=handle=>{
    const repo=createDirectoryRepository(handle),save=repo.save;
    repo.save=(candidate,revision)=>navigator.locks.request('beat-workbench:'+candidate.workspaceId,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error('其他标签正在写入，请稍后重试');return save(candidate,revision);});
    return repo;
  };
  const banner=document.createElement('div');banner.className='storage-startup';banner.setAttribute('role','status');document.body.prepend(banner);
  let pending=false,legacyDirty=false,refresh=()=>{},timerGuard=()=>false,formGuard=()=>true,hasFormDraft=()=>false,discardFormDraft=()=>{},toastQueue=[],draft=null,profileBusy=false,sourceBusy=false;
  const map=new Map();
  function fillMap(w){map.clear();map.set('jiepai-user-profiles-v1',JSON.stringify(w.profiles.map(({id,name,avatar})=>({id,name,avatar}))));map.set('jiepai-active-profile-v1',w.activeProfileId);for(const p of w.profiles){map.set('jiepai-work-logs-v2:'+p.id,JSON.stringify(p.records));map.set('jiepai-project-tasks-v1:'+p.id,JSON.stringify(p.tasks));}}
  function stateChanged(state){
    const message=(state.mode==='directory'?'已连接文件夹 · '+(state.directoryName||''):'当前浏览器')+' · '+({resolving:'正在确定数据来源',loading:'正在读取数据',migrating:'正在迁移当前数据…',verifying:'正在验证目标数据…',ready:temporary?'临时会话 · 关闭后数据会清除':'已就绪',stalled:'保存等待超时，写入可能仍在进行，请打开保存状态导出副本',saving:'正在保存…',reconnect:'无法读取已选数据，请重新连接或使用原浏览器数据',error:'最新修改尚未保存',conflict:'外部数据已修改，已停止自动保存'}[state.phase]||state.phase);
    if(get('storage-mode-status'))get('storage-mode-status').textContent=message;
    if(get('storage-detail'))get('storage-detail').textContent=message+(state.error?'：'+state.error:'');
    if(get('storage-time'))get('storage-time').textContent=state.lastSavedAt?'最近成功保存：'+new Date(state.lastSavedAt).toLocaleString():state.lastReadAt?'最近成功读取：'+new Date(state.lastReadAt).toLocaleString():'尚未保存到文件夹';
    if(get('choose-folder'))get('choose-folder').textContent=state.mode==='directory'?'迁移到其他文件夹':'迁移当前数据到文件夹';
    const directory=state.mode==='directory',failed=['error','conflict','reconnect','stalled'].includes(state.phase),authorizing=directory&&(state.phase==='reconnect'||/权限|授权|permission|not allowed/i.test(state.error||'')),writing=['saving','stalled'].includes(state.phase);
    if(get('storage-other-actions')){const more=get('storage-other-actions');if(failed){more.open=true;more.dataset.autoOpened='true';}else if(!state.dirty&&more.dataset.autoOpened==='true'){more.open=false;more.dataset.autoOpened='false';}}
    if(get('retry-save')){get('retry-save').disabled=writing;get('retry-save').title=writing?'文件仍在写入，请先导出副本，返回后再重试':'';}
    if(get('reconnect-folder'))get('reconnect-folder').disabled=writing;
    if(get('reload-folder')){get('reload-folder').disabled=writing||!!controller?.getPending();get('reload-folder').title=get('reload-folder').disabled?'请先重试或导出待保存数据':'';}
    for(const [id,visible] of [['reconnect-folder',authorizing],['browser-source',directory],['browser-copy-summary',directory],['original-browser',failed],['retry-save',state.dirty&&state.phase!=='conflict'&&!authorizing],['export-workspace',failed||state.dirty],['restore-previous',directory],['reload-folder',!!controller?.getWorkspace()]])if(get(id))get(id).hidden=!visible;
    banner.hidden=!!controller?.getWorkspace();
    if(!banner.hidden){banner.replaceChildren();const text=document.createElement('p');text.textContent=message+(state.error?'：'+state.error:'');banner.append(text);for(const [label,action] of [['重新连接',reconnect],['使用原浏览器数据',originalBrowser],['恢复上一份目录快照',repairDirectory],['创建临时会话',temporarySession]]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>action().catch(showError);banner.append(b);}}
  }
  let controller;
  controller=createWorkspaceController({browserRepo,settings,directoryFactory,onState:stateChanged,validateLoaded:async w=>{for(const p of w.profiles)await validateAvatar(p.avatar);return w;}});
  function protectPageExit(event){
    const state=controller.getState();
    if(pending||legacyDirty||profileBusy||sourceBusy||state.dirty||state.phase==='saving'){
      event.preventDefault();event.returnValue='';
    }
  }
  window.addEventListener('beforeunload',protectPageExit);
  function showError(e){const message=e.message||String(e);if(get('storage-detail'))get('storage-detail').textContent=message;alert(message);}
  document.querySelector('main').inert=true;
  await controller.initialize();
  async function reconnect(){const source=controller.getSource();if(source.handle && !await requestAccess(source.handle))throw Error('文件夹授权未获允许');if(controller.getPending()){await controller.retry();sync();}else{await controller.initialize();if(controller.getWorkspace())sync();}}
  async function repairDirectory(){
    const handle=controller.getSource().handle;if(!handle)throw Error('没有已选文件夹');
    if(!await requestAccess(handle))throw Error('未获文件夹授权');
    const previous=await readPreviousSnapshot(handle);
    for(const p of previous.profiles)await validateAvatar(p.avatar);
    if(!confirm('恢复上一份有效数据？\n'+previous.updatedAt+'\n'+summary(previous)+'\n将保留损坏原件为 beat-workbench.damaged.json，再写入恢复数据；失败可重试。'))return;
    await navigator.locks.request('beat-workbench:'+previous.workspaceId,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('其他标签正在写入');await createDirectoryRepository(handle).restorePrevious(true);});
    await controller.initialize();sync();
  }
  function collectLocalLosses(){
    const losses=[];if(draft&&changed())losses.push('当前用户资料草稿');if(hasFormDraft())losses.push('工作录入草稿');if(controller.getPending())losses.push('待保存修改');return losses;
  }
  async function originalBrowser(){
    if(sourceBusy)return;
    if(timerGuard())throw Error('请先结束计时');if(controller.isWriting?.())throw Error('文件写入仍在进行，请先导出副本，完成后再选择来源');
    sourceBusy=true;
    try{
      const value=await browserRepo.load(),losses=collectLocalLosses();
      const message=summary(value)+'\n来源时间：'+(value?.updatedAt||'无可读副本')+'\n这可能不是文件夹最新数据。将断开记住的文件夹，不修改目录文件。'+(losses.length?'\n将放弃：'+losses.join('、'):'')+(!value?'\n此操作将明确创建新的空白浏览器工作区。':'');
      const choices=[['返回','cancel']];if(controller.getPending())choices.push(['导出全工作台待保存数据','export']);choices.push([!value?'创建浏览器工作区':losses.length?'放弃修改并使用此副本':'使用此副本','use']);
      if(await folderDecision('使用原浏览器数据？',message,choices)!=='use')return;
      await controller.useOriginalBrowserData(true,!value);sync();if(draft)resetDraft();discardFormDraft();
    }finally{sourceBusy=false;}
  }
  async function temporarySession(){if(!confirm('创建临时会话？关闭后数据会清除，不会覆盖任何原数据。'))return;const memory={value:newWorkspace(),load:async()=>structuredClone(memory.value),save:async v=>{memory.value=structuredClone(v);return{savedAt:v.updatedAt};}};controller=createWorkspaceController({browserRepo:memory,settings:{read:async()=>({mode:'browser'}),write:async()=>{}},directoryFactory,onState:stateChanged});temporary=true;await controller.initialize();sync();}
  while(!controller.getWorkspace())await new Promise(resolve=>setTimeout(resolve,100));
  document.querySelector('main').inert=false;banner.hidden=true;fillMap(controller.getWorkspace());
  const storage={getItem:key=>map.get(String(key))??null,setItem:(key,value)=>{map.set(String(key),String(value));legacyDirty=true;schedule();},removeItem:key=>{map.delete(key);legacyDirty=true;schedule();}};
  function sync(){const w=controller.getWorkspace();if(w){fillMap(w);refresh(w);if(draft&&draft.id!==w.activeProfileId)resetDraft();else if(draft)updateDraft();}stateChanged(controller.getState());}
  let scheduled=false;
  function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;flushLegacy().catch(()=>{});});}
  async function flushLegacy(){
    if(!legacyDirty)return;legacyDirty=false;pending=true;
    const rawProfiles=JSON.parse(map.get('jiepai-user-profiles-v1'));
    const capturedProfiles=rawProfiles.map(p=>({...p,avatar:p.avatar||null,records:JSON.parse(map.get('jiepai-work-logs-v2:'+p.id)||'[]'),tasks:JSON.parse(map.get('jiepai-project-tasks-v1:'+p.id)||'[]')}));
    const active=map.get('jiepai-active-profile-v1');
    try{
      await controller.commit(w=>settleLegacySnapshot(w,capturedProfiles,active));
      sync();for(const message of toastQueue.splice(0)){get('toast').textContent=message;get('toast').classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>get('toast').classList.remove('show'),2600);}
    }catch(e){toastQueue=[];sync();get('storage-detail').textContent='最新修改未保存：'+e.message+'。可重试或导出待保存副本。';get('toast').textContent='保存失败，请打开数据管理重试或导出';clearTimeout(window.toastTimer);get('toast').classList.add('show');throw e;}
    finally{pending=false;}
  }
  const section=document.createElement('div');section.className='data-enhancements';section.innerHTML='<section class="profile-section"><h3>编辑当前用户资料</h3><p>修改姓名或头像会更新当前用户，原有工作记录和任务保持归属。</p><p id="current-profile-label"></p><div class="profile-editor"><span class="avatar avatar-preview" id="avatar-preview" aria-hidden="true"></span><label>显示名称<input id="profile-name" maxlength="30"></label></div><div class="profile-actions"><button type="button" id="choose-avatar">选择头像</button><input id="avatar-file" type="file" accept="image/jpeg,image/png,image/webp" hidden><button type="button" id="remove-avatar">移除头像</button><button type="button" class="primary" id="save-profile">保存当前用户资料</button></div><p class="section-sub">支持 JPEG、PNG、WebP，最大5 MB；将居中裁剪为圆形。</p><p id="profile-error" role="status"></p></section><section class="storage-section"><h3>数据存储位置</h3><p id="storage-detail" role="status"></p><p id="storage-time" class="section-sub"></p><p>选择空文件夹后将直接复制全部用户、记录、任务、头像和会话，验证成功才切换保存位置；原位置保留。已有目标数据只可读取或另选，不合并覆盖。浏览器可能要求授权。</p><p id="storage-support"></p><div class="storage-actions"><button type="button" id="choose-folder">迁移当前数据到文件夹</button><button type="button" id="reconnect-folder">重新连接</button><button type="button" id="browser-source">改用浏览器存储</button><button type="button" id="original-browser">使用原浏览器数据</button><button type="button" id="retry-save">重试保存</button><button type="button" id="export-workspace">导出当前副本</button><button type="button" id="restore-previous">查看上一份有效快照</button><button type="button" id="reload-folder">重新加载</button></div></section><h3>工作区与备份</h3>';
  const dialog=get('data-dialog');dialog.querySelector('.user-list, #user-list').before(section);
  const otherRecovery=document.createElement('details');otherRecovery.id='storage-other-actions';
  const recoveryTitle=document.createElement('summary');recoveryTitle.textContent='其他恢复方式';otherRecovery.append(recoveryTitle);
  const browserCopySummary=document.createElement('p');browserCopySummary.id='browser-copy-summary';browserCopySummary.textContent='将复制当前工作台（'+summary(controller.getWorkspace())+'）。浏览器旧副本会独立保留，目录不删除。展开后读取旧副本摘要。';otherRecovery.append(browserCopySummary);
  for(const id of ['browser-source','original-browser','restore-previous','reload-folder'])otherRecovery.append(get(id));
  section.querySelector('.storage-actions').after(otherRecovery);
  get('browser-source').textContent='保存当前数据到浏览器并切换';get('reload-folder').textContent='重新加载当前数据';get('reconnect-folder').textContent='重新授权并重试';get('export-workspace').textContent='导出全工作台待保存数据';
  otherRecovery.ontoggle=async()=>{if(!otherRecovery.open)return;try{const old=await controller.getBrowserSnapshot();browserCopySummary.textContent='当前工作台：'+summary(controller.getWorkspace())+'。浏览器副本：'+summary(old)+'（'+(old?.updatedAt||'无副本')+'）。切回浏览器前将独立保留旧浏览器副本；目录不删除。';}catch(e){browserCopySummary.textContent='浏览器副本摘要暂不可读：'+e.message+'。未切换任何来源。';}};
  function avatar(element,value){element.replaceChildren();if(value){const img=document.createElement('img');img.src=value.dataUrl;img.alt='';element.append(img);}else{const person=document.createElement('span');person.className='person-placeholder';person.setAttribute('aria-hidden','true');element.append(person);}}
  function resetDraft(){const p=controller.getWorkspace().profiles.find(p=>p.id===controller.getWorkspace().activeProfileId);draft={id:p.id,name:p.name,avatar:structuredClone(p.avatar)};get('profile-name').value=p.name;get('current-profile-label').textContent='当前用户：'+p.name;avatar(get('avatar-preview'),draft.avatar);get('profile-error').textContent='';updateDraft();}
  function changed(){const p=controller.getWorkspace().profiles.find(p=>p.id===draft?.id);return !!p&&(get('profile-name').value.trim()!==p.name.trim()||JSON.stringify(draft.avatar)!==JSON.stringify(p.avatar));}
  function updateDraft(){
    const locked=profileBusy||!!controller.getPending();get('save-profile').disabled=locked||!changed();get('save-profile').title=locked?'请先在存储区重试保存或导出待保存数据':'';get('remove-avatar').disabled=locked||!draft.avatar;get('profile-name').disabled=locked;get('avatar-file').disabled=locked;get('choose-avatar').disabled=locked;
  }
  async function guardDraft(){
    if(!changed())return true;
    return new Promise(resolve=>{
      const choice=document.createElement('dialog');choice.className='draft-choice';const content=document.createElement('div');content.className='dialog-body';
      const h=document.createElement('h2');h.textContent='资料尚未保存';const p=document.createElement('p');p.textContent='保存后继续，或放弃本次修改。';content.append(h,p);
      function finish(value){choice.close();choice.remove();resolve(value);}
      for(const [label,action] of [['继续编辑',async()=>finish(false)],['放弃更改',async()=>{resetDraft();finish(true);}],['保存并继续',async()=>{finish(await saveDraft());}]]){const b=document.createElement('button');b.textContent=label;b.onclick=action;content.append(b);}
      choice.append(content);document.body.append(choice);choice.addEventListener('cancel',e=>{e.preventDefault();finish(false);});choice.showModal();
    });
  }
  get('profile-name').oninput=updateDraft;
  get('choose-avatar').onclick=()=>get('avatar-file').click();
  get('avatar-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;profileBusy=true;updateDraft();get('profile-error').textContent='正在处理头像…';try{draft.avatar=await prepareAvatar(file);avatar(get('avatar-preview'),draft.avatar);get('profile-error').textContent='';}catch(err){get('profile-error').textContent=err.message;}finally{profileBusy=false;e.target.value='';updateDraft();}};
  get('remove-avatar').onclick=()=>{draft.avatar=null;avatar(get('avatar-preview'),null);updateDraft();};
  async function saveDraft(closeAfterSave=false){profileBusy=true;updateDraft();get('profile-error').textContent='正在保存…';try{await saveProfileDraft(controller,draft.id,{name:get('profile-name').value,avatar:draft.avatar});sync();resetDraft();get('profile-error').textContent='当前用户资料已更新，原记录和任务已保留';if(closeAfterSave){dialog.close();notifyProfileSaved();}return true;}catch(e){get('profile-error').textContent='资料未保存，请在存储区重试保存或导出待保存数据。'+e.message;return false;}finally{profileBusy=false;updateDraft();}}
  function notifyProfileSaved(){
    const toast=get('toast');toast.textContent='当前用户资料已保存';toast.classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>toast.classList.remove('show'),2600);
    const opener=document.body.classList.contains('flow-view')?get('flow-data-recovery'):get('open-data-dialog');opener?.focus();
  }
  get('save-profile').onclick=()=>saveDraft(true);
  const supported=detectDirectorySupport()&&settingsAvailable;get('choose-folder').disabled=!supported;get('storage-support').textContent=supported?'支持选择文件夹；记住授权后可在重开时读取。':'当前环境不支持自动文件夹读写，仍可使用浏览器存储和JSON备份。';
  async function guardSource(){if(timerGuard())throw Error('请先结束心流、会议或任务追踪，再切换数据来源。');if(!await guardDraft()||!formGuard())return false;await flushLegacy();if(controller.getState().dirty)throw Error('请先保存或导出待保存副本');return true;}
  function folderDecision(title,message,choices){
    return new Promise(resolve=>{
      const d=document.createElement('dialog');d.className='directory-choice';
      const body=document.createElement('div');body.className='dialog-body';const h=document.createElement('h2');h.textContent=title;const p=document.createElement('p');p.textContent=message;p.style.whiteSpace='pre-line';body.append(h,p);
      function finish(value){d.close();d.remove();resolve(value);}
      for(const [label,value] of choices){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>value==='export'?exportCurrentSnapshot():finish(value);body.append(b);}
      d.append(body);document.body.append(d);d.oncancel=e=>{e.preventDefault();finish('cancel');};d.showModal();
    });
  }
  function folderSummary(w){return summary(w)+' / '+w.profiles.reduce((n,p)=>n+p.tasks.length,0)+' 项任务\n最后保存：'+new Date(w.updatedAt).toLocaleString();}
  async function selectFolder(){
    if(sourceBusy)return;
    try{
      if(!await guardSource())return;
      sourceBusy=true;
      while(true){
        const handle=await pickDirectory(),current=controller.getSource();
        if(current.mode==='directory' && current.handle.isSameEntry && await current.handle.isSameEntry(handle)){alert('已在使用此文件夹');return;}
        let preview;
        try{preview=await controller.previewDirectory(handle);}catch(e){
          const action=await folderDecision('目标工作台数据无法验证，未迁移或覆盖',e.message,[['取消','cancel'],['选择其他文件夹','other']]);if(action==='other')continue;return;
        }
        const w=controller.getWorkspace(),details='当前来源：'+(current.mode==='directory'?current.handle.name:'当前浏览器')+'\n当前：'+folderSummary(w)+'\n当前用户：'+w.profiles.find(p=>p.id===w.activeProfileId).name+'\n目标：'+handle.name;
        if(preview.workspace){
          const action=await folderDecision('此文件夹已有工作台数据',details+'\n'+folderSummary(preview.workspace)+'\n无法将当前数据迁移到已有工作台数据的文件夹。可使用目标数据，或选择空文件夹迁移；不会合并或覆盖。', [['取消','cancel'],['选择其他文件夹','other'],['使用目标数据','open']]);
          if(action==='other')continue;if(action!=='open')return;
          await controller.activateDirectory(preview,true);sync();resetDraft();return;
        }
        await controller.migrateDirectory(preview,true);sync();resetDraft();get('storage-detail').textContent='迁移完成，后续修改将保存到此文件夹';return;
      }
    }catch(e){if(e.name!=='AbortError')showError(e);}finally{sourceBusy=false;}
  }
  get('choose-folder').onclick=selectFolder;
  get('browser-source').onclick=async()=>{try{if(!await guardSource())return;sourceBusy=true;get('storage-detail').textContent='正在保护旧浏览器副本并复制当前数据…';await controller.returnToBrowser(true);sync();resetDraft();}catch(e){showError(e);}finally{sourceBusy=false;}};
  get('original-browser').onclick=()=>originalBrowser().catch(showError);
  get('reconnect-folder').onclick=()=>reconnect().catch(showError);
  get('retry-save').onclick=async()=>{try{await controller.retry();sync();get('toast').classList.remove('show');}catch(e){showError(e);}};
  function exportCurrentSnapshot(){const value=controller.getPending()||controller.getWorkspace(),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='Beat-Workbench-workspace-recovery.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  get('export-workspace').onclick=exportCurrentSnapshot;
  async function reloadCurrentData(){
    try{
      if(timerGuard())throw Error('请先结束计时');if(controller.isWriting?.()||controller.getPending())throw Error('请先重试保存或导出待保存副本；未丢弃任何修改');
      const losses=collectLocalLosses();if(losses.length&&!confirm('重新加载将放弃：'+losses.join('、')+'。继续？'))return false;
      await controller.initialize();if(!controller.getWorkspace())throw Error('重新加载失败，草稿仍保留，请重新连接');sync();resetDraft();discardFormDraft();return true;
    }catch(e){showError(e);return false;}
  }
  get('reload-folder').onclick=reloadCurrentData;
  get('restore-previous').onclick=async()=>{try{if(timerGuard())throw Error('请先结束计时');await repairDirectory();resetDraft();}catch(e){showError(e);}};
  const browserRecovery=document.createElement('button');browserRecovery.type='button';browserRecovery.textContent='恢复原浏览器独立副本';get('restore-previous').after(browserRecovery);
  async function restoreBrowserSnapshot(value){
    if(controller.isWriting?.())throw Error('文件写入仍在进行，请先导出副本');
    for(const profile of value.profiles)await validateAvatar(profile.avatar);
    if(controller.isWriting?.())throw Error('文件写入仍在进行，请完成后再恢复');
    await browserRepo.save(value,null,{replace:true});await controller.useOriginalBrowserData(true);sync();resetDraft();discardFormDraft();
  }
  async function chooseBrowserRecovery(){
    if(sourceBusy)return;if(timerGuard())return showError(Error('请先结束计时'));if(controller.isWriting?.())return showError(Error('文件写入仍在进行，请先导出副本'));
    sourceBusy=true;
    try{
      const values=await browserRepo.recoveries();if(!values.length)throw Error('没有原浏览器恢复副本');
      const old=await controller.getBrowserSnapshot(),losses=collectLocalLosses();
      await new Promise(resolve=>{
        const d=document.createElement('dialog'),body=document.createElement('div');d.className='directory-choice';body.className='dialog-body';const h=document.createElement('h2');h.textContent='选择并恢复浏览器副本';const info=document.createElement('p');info.textContent='将替换当前浏览器数据（'+summary(old)+'），并切换为所选副本；目录文件不修改，恢复列表仍保留。'+(losses.length?' 将放弃：'+losses.join('、')+'。':'');const error=document.createElement('p');error.setAttribute('role','status');body.append(h,info,error);let busy=false;
        const buttons=[];for(const value of values){const button=document.createElement('button');buttons.push(button);button.type='button';button.textContent=(losses.length?'放弃修改并恢复此副本':'恢复此副本')+' · '+value.updatedAt+' · '+summary(value);button.onclick=async()=>{if(busy)return;busy=true;for(const item of buttons)item.disabled=true;error.textContent='正在恢复并核对数据…';try{await restoreBrowserSnapshot(value);d.close();d.remove();resolve(true);}catch(e){error.textContent='尚未完成恢复：'+e.message;}finally{busy=false;for(const item of buttons)item.disabled=false;}};body.append(button);}
        if(controller.getPending()){const backup=document.createElement('button');backup.type='button';backup.textContent='导出全工作台待保存数据';backup.onclick=exportCurrentSnapshot;body.append(backup);}
        const cancel=document.createElement('button');cancel.type='button';cancel.textContent='返回';cancel.onclick=()=>{if(busy)return;d.close();d.remove();resolve(false);};body.append(cancel);d.append(body);document.body.append(d);d.oncancel=event=>{event.preventDefault();cancel.click();};d.showModal();
      });
    }catch(e){showError(e);}finally{sourceBusy=false;}
  }
  browserRecovery.id='browser-recovery';browserRecovery.textContent='选择旧浏览器副本…';browserRecovery.onclick=chooseBrowserRecovery;
  function blockWorkspaceMutation(event){
    const input={pending,profileBusy,sourceBusy,phase:controller.getState().phase,hasPendingSnapshot:!!controller.getPending(),target:event.target};
    const fallback=()=>{const busy=input.pending||input.profileBusy||input.sourceBusy||input.phase==='saving';const allowedWhileSaving=input.target.closest('#open-data-dialog,#close-data-dialog,#flow-data-recovery,#leave-flow-mode,#retry-save,#reconnect-folder,#export-workspace,.directory-choice,.flow-checkpoint-recovery,#meeting-form');const allowedWithPendingSnapshot=input.target.closest('#open-data-dialog,#close-data-dialog,#flow-data-recovery,#leave-flow-mode,#start-flow-session,#complete-flow-session,#flow-form,#meeting-form,.flow-checkpoint-recovery,#retry-save,#export-workspace,#reconnect-folder,#original-browser,#browser-recovery');return busy?!allowedWhileSaving:input.hasPendingSnapshot&&!allowedWithPendingSnapshot;};
    const blocked=typeof shouldBlockWorkspaceMutation==='function'?shouldBlockWorkspaceMutation(input):fallback();
    if(blocked){event.preventDefault();event.stopImmediatePropagation();}
  }
  document.addEventListener('click',blockWorkspaceMutation,true);
  document.addEventListener('submit',blockWorkspaceMutation,true);
  for(const type of ['keydown','beforeinput'])document.addEventListener(type,event=>{if((sourceBusy&&!event.target.closest('.directory-choice'))||(type==='beforeinput'&&controller.getPending())){event.preventDefault();event.stopImmediatePropagation();}},true);
  for(const type of ['click','cancel'])dialog.addEventListener(type,event=>{if(type==='cancel'||event.target.closest('#close-data-dialog,[data-profile-id],#create-profile,.import-data')){
    if(timerGuard()&&type==='click'&&event.target.closest('[data-profile-id],#create-profile,.import-data')){event.preventDefault();event.stopImmediatePropagation();showError(Error('请先结束计时再切换用户'));return;}
    if(type==='click'&&event.target.closest('[data-profile-id],#create-profile,.import-data')&&!formGuard()){event.preventDefault();event.stopImmediatePropagation();return;}
    if(changed()){event.preventDefault();event.stopImmediatePropagation();const target=type==='click'?event.target.closest('button'):null;guardDraft().then(ok=>{if(ok){if(target)target.click();else dialog.close();}});}
  }},true);
  get('open-data-dialog').addEventListener('click',resetDraft,true);
  resetDraft();stateChanged(controller.getState());
  mountNotionSync({controller,container:dialog.querySelector('.data-enhancements')});
  return {storage,controller,flushLegacy,exportCurrentSnapshot,requestSourceAccess:async()=>{const handle=controller.getSource().handle;if(handle&&!await requestAccess(handle))throw Error('文件夹授权未获允许');},avatar,sync,resetDraft,isPending:()=>pending||legacyDirty||!!controller.getPending(),delayToast:message=>{if(pending||legacyDirty){toastQueue.push(message);return true;}return false;},bind:callbacks=>{refresh=callbacks.refresh;timerGuard=callbacks.timerGuard;formGuard=callbacks.formGuard;hasFormDraft=callbacks.hasFormDraft||(()=>false);discardFormDraft=callbacks.discardFormDraft||(()=>{});},isDirectory:()=>controller.getState().mode==='directory',get temporary(){return temporary;}};
}
