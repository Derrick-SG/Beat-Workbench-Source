import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {splitReport} from '../scripts/ai/report.mjs';

const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const start=source.indexOf('    async function aiApi(');
const end=source.indexOf('    function showAiStatus(',start);
assert.ok(start>=0&&end>start);
const createClient=fetch=>new Function('fetch',`let aiToken='';${source.slice(start,end)};return aiApi;`)(fetch);
const helpersStart=source.indexOf('    function estimateAiBatches(');
assert.ok(helpersStart>=0&&helpersStart<start);
const {estimateAiBatches,formatAiPreview,aiGenerationErrorMessage}=new Function('TextEncoder',`${source.slice(helpersStart,start)};return {estimateAiBatches,formatAiPreview,aiGenerationErrorMessage};`)(TextEncoder);
const reply=value=>({ok:true,json:async()=>value});

test('local AI client sends same-origin request header on session, status and generation',async()=>{
  const calls=[];
  const client=createClient(async(url,init)=>{calls.push({url,init});return reply(url.endsWith('/session')?{token:'synthetic-token'}:url.endsWith('/status')?{connected:true}:{text:'合成草稿',model:'test'});});
  assert.equal((await client('status')).connected,true);
  assert.equal((await client('generate',{report:{kind:'day',start:'2026-11-24',end:'2026-11-24',recordCount:0,items:[]}})).text,'合成草稿');
  assert.deepEqual(calls.map(call=>call.url),['/api/ai/session','/api/ai/status','/api/ai/generate']);
  for(const call of calls)assert.equal(call.init.headers['X-Workbench-Request'],'1');
  assert.equal(calls[1].init.headers['X-Workbench-Token'],'synthetic-token');
  assert.equal(calls[2].init.headers['X-Workbench-Token'],'synthetic-token');
});

test('local AI client aborts generation if scope changes while session token is pending',async()=>{
  const calls=[];let release;const pending=new Promise(resolve=>{release=resolve;});let current=true;
  const client=createClient(async(url,init)=>{calls.push({url,init});if(url.endsWith('/session')){await pending;return reply({token:'synthetic-token'});}return reply({text:'不得生成'});});
  const request=client('generate',{report:{kind:'day',start:'2026-11-24',end:'2026-11-24',recordCount:0,items:[]}},()=>current);
  current=false;release();
  await assert.rejects(request,/重新预览/);
  assert.deepEqual(calls.map(call=>call.url),['/api/ai/session']);
});

test('closing an AI preview aborts its active generate request',async()=>{
  const dialog={open:true,close(){this.open=false;}};
  const cancelStart=source.indexOf('    function cancelAiReport('),cancelEnd=source.indexOf('    function aiScope(',cancelStart);
  assert.ok(cancelStart>=0&&cancelEnd>cancelStart);
  const state=new Function('get',`let aiRequestId=0,aiAbortController=new AbortController(),aiDraftScope={kind:'year'};const signal=aiAbortController.signal;${source.slice(cancelStart,cancelEnd)};return {cancelAiReport,signal,get requestId(){return aiRequestId;},get draft(){return aiDraftScope;}};`)(()=>dialog);
  const calls=[];const client=createClient(async(url,init)=>{calls.push({url,init});if(url.endsWith('/session'))return reply({token:'synthetic-token'});if(url.endsWith('/status'))return reply({connected:true});return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));});
  await client('status');
  const request=client('generate',{report:{}},()=>true,state.signal);
  assert.equal(calls.at(-1).url,'/api/ai/generate');
  assert.equal(calls.at(-1).init.signal,state.signal);
  state.cancelAiReport();
  await assert.rejects(request,{name:'AbortError'});
  assert.equal(dialog.open,false);
  assert.equal(state.signal.aborted,true);
  assert.equal(state.draft,null);
  assert.equal(state.requestId,1);
});

test('large report preview retains every record and full allowed field text, with honest batch estimate',()=>{
  const items=Array.from({length:250},(_,index)=>({title:'记录 '+index,workDate:'2026-11-24',project:'合成项目',hours:1,outcome:'产出 '+index,nextStep:'下一步 '+index,progress:50}));
  items.at(-1).outcome+='完整尾段'.repeat(1000);
  const preview=formatAiPreview({items});
  assert.match(preview,/1\. 2026-11-24 · 记录 0/);
  assert.match(preview,/250\. 2026-11-24 · 记录 249/);
  assert.ok(preview.includes(items.at(-1).outcome));
  assert.ok(estimateAiBatches(items)>=3);
  assert.equal(estimateAiBatches(items.slice(0,101)),2);
});

test('generation error keeps server stage and explains quota limit',()=>{
  const message=aiGenerationErrorMessage(Object.assign(Error('第 2/4 批请求失败'),{code:'AI_RATE_LIMIT',status:429}));
  assert.match(message,/第 2\/4 批/);
  assert.match(message,/额度或请求频率受限/);
  assert.match(aiGenerationErrorMessage(Error('合成阶段失败')),/合成阶段失败/);
});

test('batch estimate counts JSON brackets and separators at the 64 KiB edge',()=>{
  const base=new TextEncoder().encode(JSON.stringify({value:''})).byteLength;
  const item={value:'x'.repeat(32767-base)};
  assert.equal(new TextEncoder().encode(JSON.stringify(item)).byteLength,32767);
  assert.equal(new TextEncoder().encode(JSON.stringify([item,item])).byteLength,65537);
  assert.equal(estimateAiBatches([item,item]),2);
  const validItems=Array.from({length:27},(_,index)=>({title:'记录 '+index,workDate:'2026-11-24',project:'合成项目',hours:1,outcome:'产出'.repeat(1000),nextStep:'检查',progress:50}));
  const report={kind:'year',start:'2026-01-01',end:'2026-12-31',recordCount:validItems.length,items:validItems};
  assert.equal(estimateAiBatches(validItems),splitReport(report).length);
});
