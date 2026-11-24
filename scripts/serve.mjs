import { createNotionApi } from './notion/api.mjs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const projectIdentity=createHash('sha256').update(path.resolve(fileURLToPath(new URL('../',import.meta.url))).toLowerCase()).digest('hex');
const sourceRoot = new URL('../src/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
for(const name of ['bootstrap.js','model/workspace.js','model/time.js','profile/avatar.js','profile/editor.js','storage/browser.js','storage/directory.js','storage/settings.js','storage/controller.js','timers/sessions.js','sync/notion.js','sync/projection.js']) assets.set('/'+name,[name,'text/javascript; charset=utf-8']);
export function createServer(options={}) {
  const notionApi=createNotionApi(options);
  const server=http.createServer(async (request, response) => {
    if(await notionApi.handle(request,response))return;
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    if((request.url||'').split('?')[0]==='/__beat-workbench-health'){response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(request.method==='HEAD'?undefined:JSON.stringify({app:'Beat-Workbench',project:projectIdentity,pid:process.pid}));return;}
    const asset = assets.get((request.url || '/').split('?')[0]);
    if (!asset) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const data = await readFile(new URL(asset[0], sourceRoot));
      response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) { console.error(error.message); response.writeHead(500); response.end('Unable to read source asset'); }
  });
  server.on('close',()=>notionApi.close().catch(()=>{}));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Open http://127.0.0.1:${port}/ (Ctrl+C to stop)`));
}
