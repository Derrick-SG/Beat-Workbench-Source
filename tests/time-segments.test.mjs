import test from 'node:test';
import assert from 'node:assert/strict';
test('15 seconds work, one hour closed, 15 seconds work excludes gap in all periods',async()=>{
  const {recordsInRange,segmentHours}=await import('../src/model/time.js');
  const first=new Date('2026-10-09T09:00:00').getTime();
  const segments=[{start:first,end:first+15000},{start:first+3615000,end:first+3630000}];
  const record={id:1,workDate:'2026-10-09',project:'A',timeSegments:segments};
  assert.equal(segmentHours(segments),30/3600);
  for(const range of [{start:'2026-10-09',end:'2026-10-09'},{start:'2026-10-05',end:'2026-10-11'},{start:'2026-10-01',end:'2026-10-31'},{start:'2026-01-01',end:'2026-12-31'}]){
    const rows=recordsInRange([record],range);
    assert.equal(rows.length,1);assert.equal(rows[0]._ranges.reduce((n,r)=>n+r.end-r.start,0),.5);
  }
  assert.equal(recordsInRange([record],{start:'2026-10-10',end:'2026-10-10'}).length,0);
});
