import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarPublisher } from '../../lib/studio/avatar-publisher';

test('avatar publisher bounds in-flight PCM, mixes channels and stops sending on close', async t => {
  const requests: { url: string; data: any }[]=[];
  let release: (()=>void) | undefined;
  t.mock.method(globalThis,'fetch',async(url: string, options?: RequestInit)=>{
    if(url==='/bridge/state') return Response.json({csrfToken:'test-token'});
    requests.push({url,data:JSON.parse(String(options?.body))});
    if(url.endsWith('/pcm')) await new Promise<void>(resolve=>{release=resolve;});
    return Response.json({active:true});
  });
  const warnings:string[]=[];const publisher=createAvatarPublisher(text=>warnings.push(text));
  t.after(()=>publisher.close());
  assert.equal(await publisher.start(),true);
  publisher.samples([Float32Array.of(.5,-.5),Float32Array.of(0,0)],48000);
  publisher.samples([Float32Array.of(1)],48000);
  await new Promise(resolve=>setImmediate(resolve));
  const packets=requests.filter(r=>r.url.endsWith('/pcm'));assert.equal(packets.length,1);
  const bytes=Buffer.from(packets[0].data.pcm,'base64');
  assert.equal(bytes.readFloatLE(0),.25);assert.equal(bytes.readFloatLE(4),-.25);
  release?.();publisher.close();
  publisher.samples([Float32Array.of(1)],48000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.filter(r=>r.url.endsWith('/pcm')).length,1);
  assert.equal(requests.at(-1)?.data.action,'stop');assert.deepEqual(warnings,[]);
});

test('a background heartbeat that outlives the lease resumes analysis without reselecting video',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const requests:any[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,options?:RequestInit)=>{
    if(url==='/bridge/state')return Response.json({csrfToken:'test-token'});
    const data=JSON.parse(String(options?.body));requests.push(data);
    return Response.json({active:data.action!=='ping'});
  });
  const publisher=createAvatarPublisher(()=>{});t.after(()=>publisher.close());
  await publisher.start();t.mock.timers.tick(3000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests.map(r=>[r.action,r.resume]),[['start',undefined],['ping',undefined],['start',true]]);
  publisher.close();await new Promise(resolve=>setImmediate(resolve));
  const count=requests.length;t.mock.timers.tick(15000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,count,'closing must cancel future lease recovery');
});

test('4096-sample SDK frames at 16kHz retain a bounded speech window instead of silently dropping all PCM',async t=>{
 const packets:any[]=[];t.mock.method(globalThis,'fetch',async(url:string,options?:RequestInit)=>{if(url==='/bridge/state')return Response.json({csrfToken:'test-token'});const body=JSON.parse(String(options?.body));if(url.endsWith('/pcm'))packets.push(body);return Response.json({active:true});});
 const p=createAvatarPublisher(()=>{});t.after(()=>p.close());await p.start();
 const samples=new Float32Array(4096);samples[4095]=.5;p.samples([samples],16000);await new Promise(r=>setImmediate(r));
 assert.equal(packets.length,1);assert.equal(packets[0].sampleRate,16000);const pcm=Buffer.from(packets[0].pcm,'base64');assert.equal(pcm.length,2400*4);assert.equal(pcm.readFloatLE(pcm.length-4),.5);
});

test('failed initial mouth connection retries and resumes PCM without reconnecting RTC',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const requests:any[]=[];let fail=true;
 t.mock.method(globalThis,'fetch',async(url:string,options?:RequestInit)=>{
  if(url==='/bridge/state')return Response.json({csrfToken:'new-token'});
  const data=JSON.parse(String(options?.body));requests.push(data);
  if(fail){fail=false;throw new Error('connection busy');}
  return Response.json({active:true});
 });
 const p=createAvatarPublisher(()=>{});t.after(()=>p.close());
 assert.equal(await p.start(),false);
 p.samples([Float32Array.of(.2)],16000);
 t.mock.timers.tick(3000);await new Promise(r=>setImmediate(r));
 assert.deepEqual(requests.slice(0,2).map(r=>[r.action,r.resume]),[['start',undefined],['start',true]]);
 p.samples([Float32Array.of(.2)],16000);await new Promise(r=>setImmediate(r));
 assert.equal(requests.filter(r=>r.pcm).length,1);
});

test('rotated service token is refreshed once and mouth publishing recovers',async t=>{
 let refreshed=false;const tokens:string[]=[];
 t.mock.method(globalThis,'fetch',async(url:string,options?:RequestInit)=>{
  if(url==='/bridge/state'){refreshed=true;return Response.json({csrfToken:'rotated-token'});}
  const token=(options?.headers as Record<string,string>)['X-Studio-Token'];tokens.push(token);
  return token==='rotated-token'?Response.json({active:true}):new Response('',{status:403});
 });
 const p=createAvatarPublisher(()=>{});t.after(()=>p.close());assert.equal(await p.start(),true);
 assert.equal(refreshed,true);assert.equal(tokens.at(-1),'rotated-token');
 assert.ok(tokens.length<=2,'authorization retry must be bounded');
});

test('interruption invalidates scheduled and in-flight mouth PCM and gates new PCM on the clear ACK', async t => {
  const { createAvatarRelay } = await import('../../media/avatar.mjs');
  const relay = createAvatarRelay(); t.after(() => relay.close());
  const delivered: any[] = [], requests: any[] = [];
  relay.subscribe({ on() {} }, { writeHead() {}, write(raw: string) { delivered.push(JSON.parse(raw.slice(6))); }, on() {}, destroy() {} });
  let releaseOld!: () => void, releaseClear!: () => void;
  let delayed = true;
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (url === '/bridge/state') return Response.json({ csrfToken: 'test-token' });
    const data = JSON.parse(String(options?.body)); requests.push(data);
    if (url.endsWith('/pcm')) {
      if (delayed) { delayed = false; await new Promise<void>(resolve => { releaseOld = resolve; }); }
      relay.pcm(data); return Response.json({ active: true });
    }
    const result = relay.control(data);
    if (data.action === 'clear') await new Promise<void>(resolve => { releaseClear = resolve; });
    return Response.json(result);
  });
  const p = createAvatarPublisher(() => {}); t.after(() => p.close()); await p.start();
  const oldGeneration = p.generation();
  p.samples([Float32Array.of(.5)], 24000, oldGeneration);
  await new Promise(resolve => setImmediate(resolve));
  p.clear(); await new Promise(resolve => setImmediate(resolve));
  releaseOld(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(relay.status().packets, 0, 'old HTTP body arriving after clear must be discarded');
  p.samples([Float32Array.of(.9)], 24000, oldGeneration);
  assert.equal(requests.filter(r => r.pcm).length, 1, 'old scheduled callback must not enqueue a POST');
  p.samples([Float32Array.of(.2)], 24000, p.generation());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(r => r.pcm).length, 1, 'new PCM must wait for clear ACK');
  releaseClear(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(relay.status().packets, 1);
  assert.equal(requests.filter(r => r.pcm).at(-1).generation, 1);
  assert.equal(delivered.at(-1).type, 'pcm');
});

test('clear returns failure independently of warning throttling and rejects an inactive ACK', async t => {
  let clearRequests = 0;
  const warnings: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (url === '/bridge/state') return Response.json({ csrfToken: 'test-token' });
    const data = JSON.parse(String(options?.body));
    if (data.action === 'clear') {
      clearRequests++;
      if (clearRequests === 1) return new Response('', { status: 500 });
      return Response.json({ active: false });
    }
    return Response.json({ active: true });
  });
  const p = createAvatarPublisher(message => warnings.push(message)); t.after(() => p.close());
  assert.equal(await p.start(), true);
  assert.equal(await p.clear(), false);
  assert.equal(await p.clear(), false, 'failure must reach the caller even when warnings are throttled');
  assert.equal(warnings.length, 1);
});
