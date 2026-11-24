import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareAvatar} from '../src/profile/avatar.js';
test('oversized or non-raster input is rejected before browser image processing',async()=>{
  await assert.rejects(prepareAvatar(new Blob([new Uint8Array(5*1024*1024+1)],{type:'image/png'})),/超过5 MB/);
  await assert.rejects(prepareAvatar(new Blob(['<svg></svg>'],{type:'image/png'})),/有效/);
});
