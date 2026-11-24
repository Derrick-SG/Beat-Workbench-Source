import {readFile} from 'node:fs/promises';
import {privateDirectory} from './configure.mjs';
import {secureDirectory,openStore} from './store.mjs';
import {createNotionClient} from './client.mjs';
import {createSyncEngine} from './engine.mjs';
export function createNotionService({dir=privateDirectory(),fetchImpl=fetch}={}){
 let engine,timer,pendingInit,closed=false;
 async function get(){if(closed)throw Error('本机同步服务已停止');if(engine)return engine;if(pendingInit)return pendingInit;pendingInit=(async()=>{let cfg;try{await secureDirectory(dir);cfg=JSON.parse(await readFile(dir+'/config.json','utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('本机配置无法读取，请重新运行安全配置工具');}if(!cfg.token||!cfg.parentPageId)throw Error('本机配置不完整');const store=await openStore(dir);engine=createSyncEngine({store,client:createNotionClient({...cfg,fetchImpl})});timer=setInterval(()=>engine.tick().catch(()=>{}),1000);timer.unref();return engine;})();try{return await pendingInit;}finally{pendingInit=null;}}
 return {async dispatch(action,snapshot){const e=await get();if(!e){if(action==='status')return {configured:false,phase:'unconfigured',error:'请在本机运行 scripts/configure-notion.ps1 配置内部连接，并授权目标父页'};throw Error('本机Notion尚未配置，请运行安全配置工具');}if(action==='status')return e.status();if(action==='check'){await e.check();return e.status();}if(action==='preview')return e.preview(snapshot);if(action==='import')return e.importSnapshot(snapshot);if(action==='snapshot')return e.acceptSnapshot(snapshot);if(action==='pause')return e.pause();if(action==='retry')return e.retry();throw Error('未知同步动作');},async close(){closed=true;if(pendingInit)await pendingInit.catch(()=>{});clearInterval(timer);if(engine)await engine.close();}};
}
