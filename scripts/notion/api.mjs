import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createNotionService} from './service.mjs';
export function createNotionApi({serviceFactory=createNotionService}={}){const token=randomBytes(32).toString('hex');let service;
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 return {async handle(req,res){const route=(req.url||'').split('?')[0];if(!route.startsWith('/api/notion/'))return false;const origin='http://127.0.0.1:'+req.socket.localPort,host='127.0.0.1:'+req.socket.localPort;
 const sameOrigin=req.headers.origin===origin||(!req.headers.origin&&req.method==='GET'&&req.headers['sec-fetch-site']==='same-origin'&&req.headers['x-workbench-request']==='1');
 if(req.headers.host!==host||!sameOrigin){json(res,403,{error:'同步接口拒绝非同源请求'});return true;}
 const action=route.slice('/api/notion/'.length);if(action==='session'&&req.method==='GET'){json(res,200,{token});return true;}
 const input=req.headers['x-workbench-token'];if(typeof input!=='string'||!/^[a-f0-9]{64}$/.test(input)||!timingSafeEqual(Buffer.from(input),Buffer.from(token))){json(res,403,{error:'本机请求凭据已失效，请重新连接'});return true;}
 if(!((action==='status'&&req.method==='GET')||(['check','preview','import','snapshot','retry','pause'].includes(action)&&req.method==='POST'))){json(res,405,{error:'不支持的同步动作'});return true;}
 try{let data;if(req.method==='POST'){if(!/^application\/json(?:;.*)?$/i.test(req.headers['content-type']||'')){json(res,415,{error:'需要JSON请求'});return true;}let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024){json(res,413,{error:'同步快照超过8MiB，本地记录仍保留'});return true;}chunks.push(chunk);}data=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
 service??=serviceFactory();const result=await service.dispatch(action,data);json(res,200,result);
 }catch(e){const message=/^(当前|旧|同revision|需要|Notion|远端|本机|同步|快照)/.test(e.message||'')?e.message:'本机同步请求失败，请检查连接或私有队列权限；本地保存不受影响';json(res,400,{error:message});}return true;},async close(){if(service)await service.close();}};
}
