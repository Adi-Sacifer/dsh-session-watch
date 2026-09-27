import http from 'node:http';
import assert from 'node:assert/strict';
import { keepPluginEventsAlive } from '../plugin/event-keepalive.js';
const route={path:'/plugins/events',handler(req,res){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"graph","graph":{}}\n\n');}};
const original=route.handler;
const server=http.createServer((req,res)=>route.handler(req,res));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
async function probe() {
  return new Promise((resolve,reject)=>{
    let text='',done=false,deadline;
    const req=http.get(`http://127.0.0.1:${server.address().port}/plugins/events`,res=>{
      res.on('data',chunk=>text+=chunk);
      res.on('error',error=>{if(!done)reject(error)});
      deadline=setTimeout(()=>finish(false),240);
    });
    function finish(timedOut){if(done)return;done=true;clearTimeout(deadline);req.destroy();resolve({timedOut,text});}
    req.setTimeout(90,()=>finish(true));
    req.on('error',error=>{if(!done)reject(error)});
  });
}
try {
  const before=await probe();assert.equal(before.timedOut,true);
  const dispose=keepPluginEventsAlive({webServer:{match:()=>route}},20);
  const after=await probe();assert.equal(after.timedOut,false);assert.ok(after.text.startsWith('data: {"type":"graph"'));assert.ok(after.text.includes(': session-watch keepalive'));
  dispose();assert.equal(route.handler,original);
  const restored=await probe();assert.equal(restored.timedOut,true);
  console.log('event-keepalive: 6 assertions passed; real HTTP idle timeout reproduced and prevented');
} finally {server.closeAllConnections();server.close();}
