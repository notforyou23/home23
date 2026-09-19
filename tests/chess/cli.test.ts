import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/chess/cli.js';
import { replay, type Binding } from '../../src/chess/board.js';
const delay=()=>new Promise(r=>setTimeout(r,20));
test('foreground session supports controls and excludes a second watcher with another directory', async () => {
  const root=await mkdtemp('/tmp/chess-cli-'); const dir=join(root,'session'), config=join(root,'binding.json'), doc=join(root,'game');
  const binding: Binding={windowMarker:'Fixture game',documentPath:doc,documentMarker:'fixture',moves:['d2d4','d7d5'],ownerColor:'w',channelId:'chn_01a0ba12-afc6-704a-9ad5-d4665e2e3fda'};
  const fen=replay(binding.moves).fen(); let reads=0,sends=0;
  const deps={lockRoot:join(root,'locks'),read:async()=>{reads++; return {pid:42,windowMarker:binding.windowMarker,documentMarker:binding.documentMarker,moves:binding.moves,fen,placement:fen.split(' ')[0]!};},wake:()=>({close:async()=>{},submit:async()=>{sends++;return {state:'succeeded',workIds:['fixture']};}})};
  await writeFile(doc,'fixture'); await writeFile(config,JSON.stringify(binding));
  const running=main(['start',dir,config],deps);
  try {
    for(let i=0;i<100;i++){try{await readFile(join(dir,'state.json'));break;}catch{await delay();}}
    await delay();
    await assert.rejects(main(['start',join(root,'duplicate'),config],deps),/already being held/);
    const otherDoc=join(root,'other-game'), otherConfig=join(root,'other-binding.json');
    await writeFile(otherDoc,'fixture'); await writeFile(otherConfig,JSON.stringify({...binding,documentPath:otherDoc}));
    await assert.rejects(main(['start',dir,otherConfig],deps),/already being held/);
    await main(['pause',dir],deps); const before=reads; await delay(); assert.equal(reads,before);
    assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).mode,'paused');
    await main(['status',dir],deps); await main(['resume',dir],deps);
    assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).mode,'running');
    await main(['stop',dir],deps); await running; assert.equal(sends,0);
    assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).mode,'stopped');
  } finally { await main(['stop',dir],deps).catch(()=>{}); await running; await rm(root,{recursive:true,force:true}); }
});
test('restarting interrupted state starts paused, retains PID and resumes only explicitly', async () => {
  const root=await mkdtemp('/tmp/chess-restart-'); const dir=join(root,'session'), config=join(root,'binding.json'), doc=join(root,'game');
  const binding: Binding={windowMarker:'Fixture',documentPath:doc,documentMarker:'fixture',moves:['d2d4','d7d5'],ownerColor:'w',channelId:'chn_01a0ba12-afc6-704a-9ad5-d4665e2e3fda'};
  const fen=replay(binding.moves).fen(); const sample={pid:42,windowMarker:binding.windowMarker,documentMarker:binding.documentMarker,moves:binding.moves,fen,placement:fen.split(' ')[0]!};
  const {bootstrap}=await import('../../src/chess/session.js'); const {mkdir}=await import('node:fs/promises');
  await mkdir(dir); await writeFile(doc,'fixture'); await writeFile(config,JSON.stringify(binding));
  const prior=bootstrap(binding,sample); await writeFile(join(dir,'state.json'),JSON.stringify(prior));
  let reads=0;
  const deps={lockRoot:join(root,'locks'),read:async()=>{reads++;return sample;},wake:()=>({close:async()=>{},submit:async()=>{throw new Error('unexpected wake');}})};
  const running=main(['start',dir,config],deps);
  try {
    for(let i=0;i<100;i++){const saved=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));if(saved.mode==='paused')break;await delay();}
    await delay(); assert.equal(reads,0);
    const saved=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));assert.equal(saved.id,prior.id);assert.equal(saved.pid,42);assert.equal(saved.mode,'paused');
    await main(['resume',dir],deps); await main(['stop',dir],deps); await running;
  } finally {await main(['stop',dir],deps).catch(()=>{});await running;await rm(root,{recursive:true,force:true});}
});
