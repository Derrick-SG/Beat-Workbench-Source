import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('version stamping derives the unique badge from package version and replaces stale text',async()=>{
 const {stampVersion}=await import('../scripts/build.mjs');assert.equal(stampVersion('<span id="app-version">V0.0.0</span>','1.1.1'),'<span id="app-version">V1.1.1</span>');assert.throws(()=>stampVersion('<p></p>','1.1.1'));assert.throws(()=>stampVersion('<span id="app-version"></span>','bad'));const pkg=JSON.parse(await readFile('package.json','utf8'));assert.match(pkg.version,/^\d+\.\d+\.\d+$/);assert.equal(stampVersion('<span id="app-version"></span>',pkg.version),'<span id="app-version">V'+pkg.version+'</span>');
});
