import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createAiService} from './service.mjs';

const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const allowedMessage=error=>/^(请先连接|此 ChatGPT|此账号|报告|记录|AI |ChatGPT |OAuth |用户取消|授权账户|无法读取可用模型|无法核验|第 \d|最终合成|生成阶段)/.test(error.message||'')?error.message:'本机 AI 请求失败，请检查连接后重试';
export function createAiApi({aiServiceFactory=createAiService}={}){
  const token=randomBytes(32).toString('hex');let service;
  return {async handle(req,res){
    const route=(req.url||'').split('?')[0];if(!route.startsWith('/api/ai/')&&route!=='/auth/callback')return false;
    const base='http://127.0.0.1:'+req.socket.localPort,host='127.0.0.1:'+req.socket.localPort;
    if(req.headers.host!==host||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){send(res,403,{error:'仅支持本机访问'});return true;}
    service??=aiServiceFactory();
    if(route==='/auth/callback'){
      if(req.method!=='GET'){send(res,405,{error:'不支持的请求'});return true;}
      let message='ChatGPT 已连接。可返回工作台。',status=200;
      try{await service.callback(new URL(req.url,base));}catch(error){message=allowedMessage(error);status=400;}
      res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'",'X-Content-Type-Options':'nosniff'});
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ChatGPT 授权</title><body style="font-family:system-ui;margin:3rem"><h1>ChatGPT 授权</h1><p>'+message+'</p><p>现在可以关闭此页面。</p></body></html>');return true;
    }
    const sameOrigin=req.headers.origin===base||(!req.headers.origin&&req.method==='GET'&&req.headers['sec-fetch-site']==='same-origin'&&req.headers['x-workbench-request']==='1');
    if(!sameOrigin){send(res,403,{error:'AI 接口拒绝非同源请求'});return true;}
    const action=route.slice('/api/ai/'.length);
    if(action==='session'&&req.method==='GET'){send(res,200,{token});return true;}
    const input=req.headers['x-workbench-token'];
    if(typeof input!=='string'||!/^[a-f0-9]{64}$/.test(input)||!timingSafeEqual(Buffer.from(input),Buffer.from(token))){send(res,403,{error:'本机请求凭据已失效，请重新连接'});return true;}
    if(!((action==='status'&&req.method==='GET')||(['connect','disconnect','generate'].includes(action)&&req.method==='POST'))){send(res,405,{error:'不支持的 AI 动作'});return true;}
    try{
      let data={};if(req.method==='POST'){
        if(!/^application\/json(?:;.*)?$/i.test(req.headers['content-type']||'')){send(res,415,{error:'需要 JSON 请求'});return true;}
        let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024){send(res,413,{error:'报告内容超过本机 16 MiB 请求上限，请缩小报告日期范围后重试',code:'AI_INPUT_TOO_LARGE'});return true;}chunks.push(chunk);}data=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      }
      const abort=new AbortController();if(action==='generate')res.once('close',()=>abort.abort());
      const result=action==='status'?await service.status():action==='connect'?await service.connect(base):action==='disconnect'?await service.disconnect():await service.generate(data.report,abort.signal);
      send(res,200,result);
    }catch(error){const code=['AI_RATE_LIMIT','AI_GENERATION_FAILED'].includes(error.code)?error.code:undefined;send(res,code==='AI_RATE_LIMIT'?429:400,{error:allowedMessage(error),...(code?{code}:{})});}return true;
  }};
}
