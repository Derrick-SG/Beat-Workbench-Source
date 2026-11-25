import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiService} from '../scripts/ai/service.mjs';
import {createPublicKey,generateKeyPairSync,sign} from 'node:crypto';
import {verifyIdToken} from '../scripts/ai/identity.mjs';

function memoryStore(){let value={version:1,hostId:'urn:uuid:test-host',active:null,accounts:{}};return {read:async()=>structuredClone(value),write:async next=>{value=structuredClone(next);}};}

test('OAuth starts with PKCE and uses issued client ID only after matching callback state',async()=>{
  const store=memoryStore();const calls=[];
  const fakeFetch=async(url,options)=>{calls.push({url,options});if(url.endsWith('/oauth/token'))return new Response(JSON.stringify({access_token:'access-secret',refresh_token:'refresh-secret',id_token:'id-secret',token_type:'Bearer',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'}),{status:200});throw Error('unexpected request');};
  const service=createAiService({store,fetchImpl:fakeFetch,verifyIdentity:async()=>({sub:'account-1',email:'user@example.test'}),modelList:async()=>['test-model']});
  const started=await service.connect('http://127.0.0.1:4173');const url=new URL(started.authorizeUrl);
  assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('redirect_uri'),'http://127.0.0.1:4173/auth/callback');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.has('id_token_hint'),false);
  await assert.rejects(service.callback(new URL('http://127.0.0.1:4173/auth/callback?state=wrong&code=code&client_id=oaiapp_test')),/state/i);
  await service.callback(new URL('http://127.0.0.1:4173/auth/callback?state='+url.searchParams.get('state')+'&code=code&client_id=oaiapp_test'));
  assert.equal(new URLSearchParams(calls[0].options.body).get('client_id'),'oaiapp_test');
  assert.equal((await service.status()).connected,true);
  assert.equal(JSON.stringify(await store.read()).includes('refresh-secret'),true);
  const returning=new URL((await service.connect('http://127.0.0.1:4173')).authorizeUrl);
  assert.equal(returning.searchParams.get('client_id'),'oaiapp_test');
  assert.equal(returning.searchParams.has('id_token_hint'),false);
});

test('ID token verifies signature, issuer, audience, expiry and nonce',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk=publicKey.export({format:'jwk'});jwk.kid='test-key';jwk.use='sig';jwk.alg='RS256';
  const part=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const payload={iss:'https://auth.openai.com',aud:'oaiapp_test',sub:'subject',nonce:'expected',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600};
  const jwt=p=>{const input=part({alg:'RS256',kid:'test-key',typ:'JWT'})+'.'+part(p);return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');};
  const fetchJwks=async()=>new Response(JSON.stringify({keys:[jwk]}),{status:200});
  assert.equal((await verifyIdToken(jwt(payload),'oaiapp_test','expected',fetchJwks)).sub,'subject');
  await assert.rejects(verifyIdToken(jwt({...payload,nonce:'wrong'}),'oaiapp_test','expected',fetchJwks),/nonce/i);
  await assert.rejects(verifyIdToken(jwt({...payload,aud:'other'}),'oaiapp_test','expected',fetchJwks),/audience/i);
  const signed=jwt(payload).split('.');signed[1]=part({...payload,sub:'attacker'});
  await assert.rejects(verifyIdToken(signed.join('.'),'oaiapp_test','expected',fetchJwks),/签名/);
});

test('expired token refreshes once and never places credentials in generated result',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',email:'user@example.test',accessToken:'expired',refreshToken:'old-refresh',expiresAt:0,scopes:['chatgpt.tokens.use.direct']}}});
  let refreshes=0,usedBearer;
  const fakeFetch=async(url,options)=>{
    if(url.endsWith('/oauth/token')){refreshes++;return new Response(JSON.stringify({access_token:'fresh-secret',refresh_token:'new-refresh',expires_in:3600,scope:'chatgpt.tokens.use.direct'}),{status:200});}
    if(url.endsWith('/responses')){usedBearer=options.headers.Authorization;return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'总结'})+'\n\n'+'data: '+JSON.stringify({type:'response.completed'})+'\n\n',{headers:{'content-type':'text/event-stream'}});}
    throw Error('unexpected request');
  };
  const service=createAiService({store,fetchImpl:fakeFetch,modelList:async()=>['test-model']});
  const report={kind:'day',start:'2026-11-24',end:'2026-11-24',recordCount:0,items:[]};
  assert.deepEqual(await service.generate(report),{text:'总结',model:'test-model'});
  assert.equal(refreshes,1);assert.equal(usedBearer,'Bearer fresh-secret');
  assert.equal((await store.read()).accounts['oaiapp_test:subject'].refreshToken,'new-refresh');
});

test('OAuth callback is one-use and missing direct scope cannot persist a connection',async()=>{
  const store=memoryStore();let exchanges=0;
  const service=createAiService({store,fetchImpl:async()=>{exchanges++;return new Response(JSON.stringify({access_token:'secret',refresh_token:'secret',id_token:'secret',scope:'openid profile'}),{status:200});},verifyIdentity:async()=>({sub:'subject'})});
  const url=new URL((await service.connect('http://127.0.0.1:4173')).authorizeUrl);
  const callback=new URL('http://127.0.0.1:4173/auth/callback?state='+url.searchParams.get('state')+'&code=code&client_id=oaiapp_test');
  await assert.rejects(service.callback(callback),/未授予/);
  await assert.rejects(service.callback(callback),/state/i);
  assert.equal(exchanges,1);assert.equal((await service.status()).connected,false);
  assert.equal(JSON.stringify(await store.read()).includes('secret'),false);
});

test('disconnect clears local tokens even when remote revocation cannot be confirmed',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',email:'user@example.test',accessToken:'secret-access',refreshToken:'secret-refresh',expiresAt:Date.now()+3600000,scopes:['chatgpt.tokens.use.direct']}}});
  const service=createAiService({store,fetchImpl:async()=>{throw Error('network down');}});
  assert.deepEqual(await service.disconnect(),{connected:false,revocationConfirmed:false});
  assert.equal((await service.status()).connected,false);
  assert.equal(JSON.stringify(await store.read()).includes('secret-'),false);
});

test('parallel generations share one rotating refresh',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',accessToken:'expired',refreshToken:'old-refresh',expiresAt:0,scopes:['chatgpt.tokens.use.direct']}}});
  let refreshes=0;const fakeFetch=async url=>{
    if(url.endsWith('/oauth/token')){refreshes++;await new Promise(resolve=>setTimeout(resolve,10));return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:'chatgpt.tokens.use.direct'}),{status:200});}
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'草稿'})+'\n\n'+'data: '+JSON.stringify({type:'response.completed'})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const service=createAiService({store,fetchImpl:fakeFetch,modelList:async()=>['test-model']});
  const report={kind:'day',start:'2026-11-24',end:'2026-11-24',recordCount:0,items:[]};
  const results=await Promise.all([service.generate(report),service.generate(report)]);
  assert.equal(refreshes,1);assert.equal(results[0].text,'草稿');assert.equal(results[1].text,'草稿');
});

test('disconnect during refresh cannot restore a token afterward',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',accessToken:'expired',refreshToken:'old-refresh',expiresAt:0,scopes:['chatgpt.tokens.use.direct']}}});
  let release;const gate=new Promise(resolve=>release=resolve);let requested;const entered=new Promise(resolve=>requested=resolve);
  const fakeFetch=async url=>{if(url.endsWith('/oauth/token')){requested();await gate;return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:'chatgpt.tokens.use.direct'}),{status:200});}throw Error('offline');};
  const service=createAiService({store,fetchImpl:fakeFetch,modelList:async()=>['test-model']});
  const report={kind:'day',start:'2026-11-24',end:'2026-11-24',recordCount:0,items:[]};
  const pending=service.generate(report);await entered;await service.disconnect();release();
  await assert.rejects(pending,/连接|断开|失效/);
  assert.equal((await service.status()).connected,false);
  assert.equal(JSON.stringify(await store.read()).includes('new-access'),false);
});

test('yearly generation processes all 566 records and composes one final draft',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',accessToken:'access',refreshToken:'refresh',expiresAt:Date.now()+3600000,scopes:['chatgpt.tokens.use.direct']}}});
  const seen=[];let calls=0;const fakeFetch=async(url,options)=>{
    assert.ok(url.endsWith('/responses'));const payload=JSON.parse(options.body);assert.equal(payload.store,false);assert.equal(payload.stream,true);
    const content=JSON.parse(payload.input[0].content);calls++;
    if(content.items)seen.push(...content.items.map(item=>item.title));
    const text=content.items?'批次摘要 '+calls:'最终报告';
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:text})+'\n\n'+'data: '+JSON.stringify({type:'response.completed'})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const service=createAiService({store,fetchImpl:fakeFetch,modelList:async()=>['test-model']});
  const items=Array.from({length:566},(_,index)=>({title:'工作 '+index,workDate:'2026-11-24',project:'测试项目',hours:1,outcome:'成果',nextStep:'',progress:50}));
  const result=await service.generate({kind:'year',start:'2026-01-01',end:'2026-12-31',recordCount:items.length,items});
  assert.equal(result.text,'最终报告');assert.deepEqual(seen,items.map(item=>item.title));assert.ok(calls>=7);
});

test('failed batch returns its stage and rate limit without returning a partial draft',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',accessToken:'access',refreshToken:'refresh',expiresAt:Date.now()+3600000,scopes:['chatgpt.tokens.use.direct']}}});
  let calls=0;const fakeFetch=async()=>{calls++;if(calls===2)return new Response('limit',{status:429});return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'第一批'})+'\n\n'+'data: '+JSON.stringify({type:'response.completed'})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
  const service=createAiService({store,fetchImpl:fakeFetch,modelList:async()=>['test-model']});
  const items=Array.from({length:201},(_,index)=>({title:'工作 '+index,workDate:'2026-11-24',project:'项目',hours:1,outcome:'成果',nextStep:'',progress:50}));
  await assert.rejects(service.generate({kind:'year',start:'2026-01-01',end:'2026-12-31',recordCount:items.length,items}),error=>error.code==='AI_RATE_LIMIT'&&/第 2\/3 批/.test(error.message));
  assert.equal(calls,2);
});

test('aborting a batched report stops later model calls',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',accessToken:'access',refreshToken:'refresh',expiresAt:Date.now()+3600000,scopes:['chatgpt.tokens.use.direct']}}});
  const abort=new AbortController();let calls=0;
  const fakeFetch=async()=>{calls++;if(calls===1)abort.abort();return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'第一批'})+'\n\n'+'data: '+JSON.stringify({type:'response.completed'})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
  const service=createAiService({store,fetchImpl:fakeFetch,modelList:async()=>['test-model']});
  const items=Array.from({length:201},(_,index)=>({title:'工作 '+index,workDate:'2026-11-24',project:'项目',hours:1,outcome:'成果',nextStep:'',progress:50}));
  await assert.rejects(service.generate({kind:'year',start:'2026-01-01',end:'2026-12-31',recordCount:items.length,items},abort.signal),/取消/);
  assert.equal(calls,1);
});

test('many batch summaries are hierarchically merged within bounded inputs',async()=>{
  const store=memoryStore();await store.write({version:1,hostId:'urn:uuid:test-host',active:'oaiapp_test:subject',accounts:{'oaiapp_test:subject':{clientId:'oaiapp_test',subject:'subject',accessToken:'access',refreshToken:'refresh',expiresAt:Date.now()+3600000,scopes:['chatgpt.tokens.use.direct']}}});
  let batchCalls=0,mergeCalls=0,maxInputBytes=0;
  const fakeFetch=async(url,options)=>{const body=JSON.parse(options.body),content=JSON.parse(body.input[0].content);maxInputBytes=Math.max(maxInputBytes,Buffer.byteLength(body.input[0].content));let text;if(content.items){batchCalls++;text='摘'.repeat(2300);}else {mergeCalls++;text=body.instructions.includes('请把各批')?'最终':'中间摘要';}return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:text})+'\n\n'+'data: '+JSON.stringify({type:'response.completed'})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
  const service=createAiService({store,fetchImpl:fakeFetch,modelList:async()=>['test-model']});
  const items=Array.from({length:2001},(_,index)=>({title:'工作 '+index,workDate:'2026-11-24',project:'项目',hours:1,outcome:'成果',nextStep:'',progress:50}));
  const result=await service.generate({kind:'year',start:'2026-01-01',end:'2026-12-31',recordCount:items.length,items});
  assert.equal(result.text,'最终');assert.equal(batchCalls,21);assert.ok(mergeCalls>=2);assert.ok(maxInputBytes<70*1024);
});
