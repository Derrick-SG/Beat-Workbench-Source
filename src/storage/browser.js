import { validateWorkspace, readLegacyBrowser, storageError } from '../model/workspace.js';
import { databaseTransaction } from './settings.js';
export function createBrowserRepository(indexedDB=globalThis.indexedDB,local=globalThis.localStorage) {
  let backend=null,legacyCache;
  async function load(){
    if(backend!== 'local') {
      try {const value=await databaseTransaction('workspaces','readonly',(s,set)=>{const r=s.get('current');r.onsuccess=()=>set(r.result||null);},indexedDB);backend='idb';if(value)return validateWorkspace(value);}
      catch(e){if(backend==='idb')throw e;backend='local';}
    }
    const raw=local?.getItem('beat-workbench-current-v1');
    if(raw)return validateWorkspace(JSON.parse(raw));
    if(legacyCache===undefined)legacyCache=readLegacyBrowser(local);
    return structuredClone(legacyCache);
  }
  async function save(candidate,expectedRevision,options={}) {
    validateWorkspace(candidate);
    if(backend==='idb') {
      await databaseTransaction('workspaces','readwrite',s=>{
        const request=s.get('current');request.onsuccess=()=>{
          const prior=request.result;
          if(!options.replace && ((prior||legacyCache)?.revision??null)!==expectedRevision){s.transaction.abort();return;}
          if(options.preserve && (prior||options.recovery)){
            const old=prior||options.recovery,archives=s.get('recovery-list');
            archives.onsuccess=()=>{const list=archives.result||[];if(!list.some(w=>JSON.stringify(w)===JSON.stringify(old)))list.push(old);s.put(list,'recovery-list');};
          }
          s.put(candidate,'current');
        };
      },indexedDB);
    }else{
      const raw=local.getItem('beat-workbench-current-v1'),prior=raw?JSON.parse(raw):null;
      if(!options.replace && ((prior||legacyCache)?.revision??null)!==expectedRevision)throw storageError('conflict','浏览器数据已在其他标签修改');
      if(options.preserve && (prior||options.recovery)){
        const list=JSON.parse(local.getItem('beat-workbench-recovery-list-v1')||'[]'),old=prior||options.recovery;
        if(!list.some(w=>JSON.stringify(w)===JSON.stringify(old)))list.push(old);
        local.setItem('beat-workbench-recovery-list-v1',JSON.stringify(list));
      }
      local.setItem('beat-workbench-current-v1',JSON.stringify(candidate));
    }
    return {workspaceId:candidate.workspaceId,revision:candidate.revision,savedAt:candidate.updatedAt};
  }
  async function recoveries(){
    const list=backend==='idb'?await databaseTransaction('workspaces','readonly',(s,set)=>{const r=s.get('recovery-list');r.onsuccess=()=>set(r.result||[]);},indexedDB):JSON.parse(local.getItem('beat-workbench-recovery-list-v1')||'[]');
    return list.map(validateWorkspace);
  }
  return {load,save,recoveries,recovery:async()=>(await recoveries())[0]||null,flush:async()=>{},getBackend:()=>backend};
}
