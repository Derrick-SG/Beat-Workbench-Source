import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {probeServer,ensureServer} from '../scripts/launch.mjs';
import {createServer} from '../scripts/serve.mjs';
test('launcher reuses matching project and refuses foreign service without stopping it',async()=>{
  for(const own of [true,false]){
    const server=own?createServer():http.createServer((req,res)=>{res.end('unrelated');});server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
    try{assert.equal((await probeServer(port)).status,own?'ready':'occupied');let spawns=0;const spawn=()=>{spawns++;throw Error('must not spawn');};if(own)assert.equal((await ensureServer({port,spawn})).status,'reused');else await assert.rejects(ensureServer({port,spawn}),/其他服务|无法确认/);assert.equal(spawns,0);assert.ok(server.listening);}finally{await new Promise(r=>server.close(r));}
  }
});
test('launcher starts missing service on isolated port then probes readiness',async()=>{
  const temp=http.createServer();temp.listen(0,'127.0.0.1');await once(temp,'listening');const port=temp.address().port;await new Promise(r=>temp.close(r));let child;
  try{const result=await ensureServer({port,onSpawn:p=>{child=p;}});assert.equal(result.status,'started');assert.equal((await probeServer(port)).status,'ready');}finally{if(child){child.kill();await once(child,'exit');}}
});
