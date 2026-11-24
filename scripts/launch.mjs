import {spawn as spawnProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const project=createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
const assets=['index.html','styles.css','app.js','bootstrap.js','model/workspace.js','model/time.js','profile/avatar.js','profile/editor.js','storage/browser.js','storage/directory.js','storage/settings.js','storage/controller.js','timers/sessions.js','sync/notion.js','sync/projection.js'];
export async function probeServer(port=4173){
  const base='http://127.0.0.1:'+port;
  try{
    const response=await fetch(base+'/',{signal:AbortSignal.timeout(1500)});
    if(response.status!==200)return {status:'occupied'};
    const html=await response.text();
    if(html!==await readFile(path.join(root,'src/index.html'),'utf8'))return {status:'occupied'};
    for(const asset of assets.slice(1)){
      const r=await fetch(base+'/'+asset,{signal:AbortSignal.timeout(1500)});
      if(r.status!==200 || await r.text()!==await readFile(path.join(root,'src',asset),'utf8'))return {status:'occupied'};
    }
    const health=await fetch(base+'/__beat-workbench-health',{signal:AbortSignal.timeout(1500)});
    if(health.status===200){const value=await health.json();if(value.app!=='Beat-Workbench'||value.project!==project)return {status:'occupied'};return {status:'ready',pid:value.pid,project};}
    return {status:'ready',project,legacy:true};
  }catch(e){if(e.cause?.code==='ECONNREFUSED')return {status:'stopped'};return {status:'occupied'};}
}
export async function ensureServer({port=4173,spawn=spawnProcess,onSpawn=()=>{}}={}){
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口无效');
  const existing=await probeServer(port);
  if(existing.status==='ready')return {...existing,status:'reused',url:'http://127.0.0.1:'+port+'/#work-entry'};
  if(existing.status!=='stopped')throw Error('端口被其他服务占用，或无法确认是当前项目。未终止任何进程；请联系 PM 检查。');
  const child=spawn(process.execPath,[path.join(root,'scripts/serve.mjs')],{cwd:root,env:{...process.env,PORT:String(port)},detached:true,windowsHide:true,stdio:'ignore'});
  onSpawn(child);let error;child.on('error',e=>{error=e;});child.unref();
  for(let i=0;i<40;i++){
    await new Promise(r=>setTimeout(r,250));if(error)throw error;
    const state=await probeServer(port);
    if(state.status==='ready')return {...state,status:'started',pid:child.pid,url:'http://127.0.0.1:'+port+'/#work-entry'};
    if(child.exitCode!==null)throw Error('本地服务启动失败，端口可能刚被占用。未终止其他进程。');
  }
  child.kill();throw Error('等待本地服务启动超时；已停止本次启动的子进程。');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=process.argv.includes('--probe')?await probeServer():await ensureServer();console.log(JSON.stringify(result));}catch(e){console.error(e.message);process.exitCode=1;}
}
