import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from '../scripts/serve.mjs';

test('AI routes reject foreign origins and require a local session token',async()=>{
  let generated=0;const service={status:async()=>({connected:false}),connect:async()=>({authorizeUrl:'https://auth.openai.com/test'}),disconnect:async()=>({connected:false}),generate:async()=>{generated++;return {text:'草稿',model:'test-model'};},callback:async()=>({connected:true})};
  const server=createServer({aiServiceFactory:()=>service});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(base+'/api/ai/session',{headers:{Origin:'http://evil.invalid','X-Workbench-Request':'1'}})).status,403);
    const session=await(await fetch(base+'/api/ai/session',{headers:{Origin:base,'X-Workbench-Request':'1'}})).json();assert.equal(session.token.length,64);
    assert.equal((await fetch(base+'/api/ai/status',{headers:{Origin:base}})).status,403);
    assert.equal((await fetch(base+'/api/ai/status',{headers:{Origin:base,'X-Workbench-Token':session.token}})).status,200);
    assert.equal((await fetch(base+'/api/ai/status',{headers:{'Sec-Fetch-Site':'same-origin','X-Workbench-Request':'1','X-Workbench-Token':session.token}})).status,200);
    const headers={Origin:base,'X-Workbench-Token':session.token,'Content-Type':'application/json'};
    const report={kind:'day',start:'2026-11-24',end:'2026-11-24',recordCount:0,items:[]};
    assert.equal((await fetch(base+'/api/ai/generate',{method:'POST',headers,body:JSON.stringify({report})})).status,200);assert.equal(generated,1);
    const large={...report,kind:'year',start:'2026-01-01',end:'2026-12-31',items:Array.from({length:50},(_,i)=>({title:'工作 '+i,workDate:'2026-11-24',project:'项目',hours:1,outcome:'成果'.repeat(1200),nextStep:'',progress:50})),recordCount:50};
    assert.ok(Buffer.byteLength(JSON.stringify({report:large}))>128*1024);
    assert.equal((await fetch(base+'/api/ai/generate',{method:'POST',headers,body:JSON.stringify({report:large})})).status,200);assert.equal(generated,2);
    assert.equal((await fetch(base+'/api/ai/generate',{method:'POST',headers:{...headers,Origin:'http://evil.invalid'},body:JSON.stringify({report})})).status,403);assert.equal(generated,2);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('AI API exposes batch and quota failure without exposing any partial draft',async()=>{
  const service={generate:async()=>{const error=new Error('第 2/6 批触发 ChatGPT 额度或频率限制，请稍后重试');error.code='AI_RATE_LIMIT';throw error;}};
  const server=createServer({aiServiceFactory:()=>service});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  try{const token=(await(await fetch(base+'/api/ai/session',{headers:{Origin:base}})).json()).token;const response=await fetch(base+'/api/ai/generate',{method:'POST',headers:{Origin:base,'X-Workbench-Token':token,'Content-Type':'application/json'},body:JSON.stringify({report:{}})});assert.equal(response.status,429);const data=await response.json();assert.equal(data.code,'AI_RATE_LIMIT');assert.match(data.error,/第 2\/6 批/);assert.equal('text' in data,false);}finally{await new Promise(resolve=>server.close(resolve));}
});
