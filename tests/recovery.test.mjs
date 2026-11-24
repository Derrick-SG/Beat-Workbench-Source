import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

test('standalone inlines current source while original reference remains immutable', async () => {
  assert.ok(existsSync('src/app.js'), 'editable application source is missing');
  const { build } = await import('../scripts/build.mjs');
  await build();
  assert.equal(createHash('sha256').update(readFileSync('reference/2026-09-22/节拍工作台.html')).digest('hex'),'b21f2b8fd8334e31741369c0c8f84465040ce7839b38b8f0fc3b358d2ee2cc13');
  const output=readFileSync('dist/节拍工作台.html','utf8');
  assert.ok(!output.includes('src="./app.js"'));
  assert.ok(output.includes(readFileSync('src/styles.css','utf8')));
  new vm.Script('(async()=>{'+output.match(/<script type="module">([\s\S]*?)<\/script>/)[1]+'})');
});
