import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('standalone packs scoped modules without external module dependencies',async()=>{
  const {bundleModule}=await import('../scripts/build.mjs');
  const text=await bundleModule('src/profile/editor.js');
  const result=await vm.runInNewContext('(async()=>{'+text+';return __modules;})()', {structuredClone});
  assert.equal(typeof result['src/profile/editor.js'].validateName,'function');
  assert.equal(result['src/profile/editor.js'].validateName(' 名 ',[],'x'),'名');
  assert.ok(!/^import /m.test(text));
});
