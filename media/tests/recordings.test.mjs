import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecordings } from '../recordings.mjs';
test('two real PCM directions stay aligned in separate WAV channels and survive restart', () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),'call-recording-'));let now=1000;
 try {
  const r=createRecordings(dir,()=>now), id=r.start('call','Node Virtual Mic');assert.equal(r.start('call'),id);
  const packet=value=>{const b=Buffer.alloc(480*8);for(let i=0;i<960;i++)b.writeFloatLE(value,i*4);return b;};
  now+=10;r.packet('incoming',packet(.5));r.packet('input',packet(-.25));
  now+=20;r.packet('incoming',packet(.75));r.packet('input',packet(.25));
  r.finish();const wav=readFileSync(r.file(id));assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(40),1440*4);
  assert.equal(wav.readInt16LE(44),16384);assert.equal(wav.readInt16LE(46),-8192);
  assert.equal(wav.readInt16LE(44+600*4),0,'timestamp gap is silence');
  assert.equal(wav.readInt16LE(44+1000*4),24575);
  assert.equal(createRecordings(dir).status().items[0].id,id);assert.equal(r.file('../../secret'),null);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('missing direction is visibly marked instead of claiming a complete two-way recording',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'call-recording-'));
 try {const r=createRecordings(dir);r.start('empty');r.finish();assert.match(r.status().items[0].warning,/本方音轨未收到采样/);assert.equal(r.status().active,null);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('call recording uses configured virtual input when process discovery has not reported it yet',async()=>{
 const { recordingInput }=await import('../recordings.mjs');
 const value=recordingInput({defaultInput:['Node Virtual Mic'],processes:[{bundle:'com.tencent.WeWorkMac',inputActive:false,input:[]}]});
 assert.equal(value.name,'Node Virtual Mic');assert.match(value.warning,/不明确/);
 assert.equal(recordingInput({defaultInput:['Node Virtual Mic'],processes:[{bundle:'com.tencent.WeWorkMac',inputActive:true,input:['Headset']}]}).name,'Headset');
 assert.equal(recordingInput({defaultInput:['MacBook Pro麦克风'],processes:[]}).name,'');
 assert.equal(recordingInput({defaultInput:['Node Virtual Mic'],processes:[{bundle:'com.tencent.WeWorkMac',inputActive:true,input:['Node Virtual Mic','MacBook Pro扬声器']}]}).name,'Node Virtual Mic');
});

test('deletion removes only a completed recording and remains deleted after restart',async()=>{
 const {existsSync,writeFileSync}=await import('node:fs');
 const dir=mkdtempSync(path.join(os.tmpdir(),'call-delete-'));
 try {
  const r=createRecordings(dir);const id=r.start('delete-me');
  assert.throws(()=>r.remove(id),/正在录音/);assert.equal(r.status().active.id,id);
  r.packet('incoming',Buffer.alloc(480*8));r.finish();
  const keep=r.start('keep-me');r.finish();const keepPath=r.file(keep);const keepBytes=readFileSync(keepPath);
  const unrelated=path.join(dir,'unrelated.txt');writeFileSync(unrelated,'keep');
  assert.throws(()=>r.remove('../../unrelated.txt'),/标识/);
  assert.equal(r.remove(id),true);assert.equal(r.remove(id),false);
  assert.equal(r.file(id),null);assert.equal(existsSync(path.join(dir,id+'.wav')),false);assert.equal(existsSync(path.join(dir,id+'.json')),false);
  assert.deepEqual(createRecordings(dir).status().items.map(x=>x.id),[keep]);assert.deepEqual(readFileSync(keepPath),keepBytes);assert.equal(readFileSync(unrelated,'utf8'),'keep');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
