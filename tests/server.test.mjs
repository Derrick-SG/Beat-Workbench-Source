import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { once } from 'node:events';

test('loopback server serves actual source assets and rejects non-assets/mutations', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [url, file, mime] of [['/', 'index.html', 'text/html'], ['/app.js','app.js','text/javascript'], ['/styles.css','styles.css','text/css']]) {
      const response = await fetch(base + url);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(mime));
      assert.equal(await response.text(), await readFile(new URL('../src/' + file, import.meta.url), 'utf8'));
    }
    for (const url of ['/README.md', '/%2e%2e/role-boundaries.md', '/missing']) assert.equal((await fetch(base + url)).status, 404);
    assert.equal((await fetch(base, {method:'POST'})).status, 405);
    assert.equal(await (await fetch(base, {method:'HEAD'})).text(), '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
