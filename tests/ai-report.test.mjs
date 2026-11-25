import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReport, readCompletedText,splitReport} from '../scripts/ai/report.mjs';

const report={kind:'day',start:'2026-11-24',end:'2026-11-24',recordCount:1,items:[{title:'整理方案',workDate:'2026-11-24',project:'测试项目',hours:1.5,outcome:'完成初稿',nextStep:'检查',progress:50}]};

test('AI projection accepts only selected-range whitelisted saved-record fields',()=>{
  assert.deepEqual(validateReport(report),report);
  assert.throws(()=>validateReport({...report,items:[{...report.items[0],meetingContent:'private'}]}),/字段/);
  assert.throws(()=>validateReport({...report,items:[{...report.items[0],workDate:'2026-11-23'}]}),/范围/);
  assert.throws(()=>validateReport({...report,recordCount:2}),/数量/);
  assert.throws(()=>validateReport({...report,start:'2026-02-30'}),/范围/);
  assert.throws(()=>validateReport({...report,start:'2026-13-01'}),/范围/);
  assert.equal(validateReport({...report,items:[{...report.items[0],outcome:'A'.repeat(3000)}]}).items[0].outcome.length,3000);
});

test('large yearly report keeps every record across bounded batches',()=>{
  const items=Array.from({length:566},(_,index)=>({...report.items[0],title:'工作 '+index,outcome:'成果 '+index,workDate:'2026-11-24'}));
  const annual={kind:'year',start:'2026-01-01',end:'2026-12-31',recordCount:items.length,items};
  const batches=splitReport(validateReport(annual));
  assert.ok(batches.length>1);
  assert.deepEqual(batches.flatMap(batch=>batch.items.map(item=>item.title)),items.map(item=>item.title));
  assert.ok(batches.every(batch=>batch.items.length<=100));
  assert.ok(batches.every(batch=>Buffer.byteLength(JSON.stringify(batch.items))<=65536));
});

test('report over 100 KiB is batched without truncating contents',()=>{
  const items=Array.from({length:30},(_,index)=>({...report.items[0],title:'工作 '+index,outcome:'成果'.repeat(1200)}));
  const annual={kind:'year',start:'2026-01-01',end:'2026-12-31',recordCount:items.length,items};
  assert.ok(Buffer.byteLength(JSON.stringify(annual))>100*1024);
  const batches=splitReport(validateReport(annual));
  assert.equal(batches.reduce((count,batch)=>count+batch.recordCount,0),items.length);
  assert.ok(batches.length>1);
});

test('AI draft is accepted only after a completed Responses stream',async()=>{
  const stream=body=>new Response(body,{headers:{'content-type':'text/event-stream'}});
  const completed='data: '+JSON.stringify({type:'response.output_text.delta',delta:'总结'})+'\n\n'+'data: '+JSON.stringify({type:'response.completed'})+'\n\n';
  assert.equal(await readCompletedText(stream(completed)),'总结');
  await assert.rejects(readCompletedText(stream('data: '+JSON.stringify({type:'response.output_text.delta',delta:'半段'})+'\n\n')),/未完成/);
  await assert.rejects(readCompletedText(stream('data: '+JSON.stringify({type:'response.failed',response:{error:{code:'rate_limit'}}})+'\n\n')),/失败/);
  await assert.rejects(readCompletedText(stream('data: '+JSON.stringify({type:'response.failed',response:{error:{code:'rate_limit'}}})+'\n\n')),/rate_limit/);
  const chunks=['data: {"type":"response.output_text.', 'delta","delta":"分块"}\n\n', 'data: {"type":"response.completed"}\n\n'];
  const split=new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
  assert.equal(await readCompletedText(split),'分块');
  const final=stream('data: '+JSON.stringify({type:'response.completed',response:{output:[{content:[{type:'output_text',text:'完整结果'}]}]}})+'\n\n');
  assert.equal(await readCompletedText(final),'完整结果');
});
