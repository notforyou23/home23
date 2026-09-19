import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { bootstrap, ChessSession, type Session } from '../../src/chess/session.js';
import { AX_SCRIPT, type Binding, type Sample, hash, placement, replay, uniqueTransition } from '../../src/chess/board.js';
import { atomicWrite } from '../../src/chess/store.js';
import { signedChessWake } from '../../src/chess/wake.js';
const initial = ['d2d4','d7d5','e2e4','d5e4'];
const binding: Binding = { windowMarker:'Game 2 | owner - Auto-Match Player', documentPath:'/fixture/game', documentMarker:'fixture-marker', moves:initial, ownerColor:'w', channelId:'chn_01a0ba12-afc6-704a-9ad5-d4665e2e3fda' };
function sample(moves = initial): Sample { const fen = replay(moves).fen(); return { pid:42,windowMarker:binding.windowMarker,documentMarker:binding.documentMarker,moves:[...moves],fen,placement:fen.split(' ')[0]! }; }
function rig(wake?: (input: any) => Promise<any>, prior?: Session) {
  const writes: Session[] = [], sends: any[] = [], reports: string[] = [];
  const c = new ChessSession(prior ?? bootstrap(binding, sample()), async state => { writes.push(structuredClone(state)); }, async input => {
    assert.equal(writes.at(-1)?.pending?.runId, input.runId, 'outbox must precede network');
    sends.push(structuredClone(input)); return wake ? wake(input) : {state:'succeeded',workIds:['work-1']};
  }, reason => reports.push(reason));
  return { c,writes,sends,reports };
}
async function stable(c: ChessSession, value: Sample) { await c.observe(value); await c.observe(value); }
test('idle and one transient sample are silent; unique White move wakes once; Black reply does not wake', async () => {
  const { c,sends } = rig(); await stable(c,sample()); assert.equal(sends.length,0);
  const white = [...initial,'b1c3']; await c.observe(sample(white)); assert.equal(sends.length,0);
  await c.observe(sample(white)); assert.equal(sends.length,1); assert.match(sends[0].prompt,/Nc3/);
  await stable(c,sample(white)); assert.equal(sends.length,1);
  await stable(c,sample([...white,'g8f6'])); assert.equal(sends.length,1); assert.equal(c.state.mode,'running');
  await stable(c,sample([...white,'g8f6','c1f4'])); assert.equal(sends.length,2);
});
test('crash/lost acknowledgement preserves exact request; successful replay clears outbox', async () => {
  const { c,writes,reports } = rig(async () => { throw new Error('lost'); });
  const white = sample([...initial,'b1c3']); await stable(c,white);
  assert.equal(c.state.mode,'paused'); assert.equal(reports.length,1);
  const request = structuredClone(c.state.pending);
  let count=0;
  const restored = new ChessSession(structuredClone(writes.at(-1)!),async () => {},async input => { assert.deepEqual(input,request); count++; return {state:'succeeded',workIds:['same-work']}; },()=>{});
  await restored.resume(); await stable(restored,white); await stable(restored,white);
  assert.equal(count,1); assert.equal(restored.state.pending,undefined);
});
test('failed or empty canonical receipt pauses without new event IDs', async () => {
  for (const result of [{state:'failed'}, {state:'succeeded',workIds:[]}]) {
    const {c,sends} = rig(async () => result); await stable(c,sample([...initial,'b1c3']));
    assert.equal(c.state.mode,'paused'); assert.ok(c.state.pending); assert.equal(sends.length,1);
  }
});
test('pending Work blocks next owner event and preserves event ID while checking status', async () => {
  const {c,sends} = rig(async () => ({state:'running',workIds:['work-1']}));
  await stable(c,sample([...initial,'b1c3'])); const id = c.state.pending!.runId;
  await stable(c,sample([...initial,'b1c3','g8f6']));
  assert.equal(c.state.moves.length,5); assert.ok(sends.every(s=>s.runId===id));
});
test('identity change, history reset, multiple moves, illegal board and document lag pause once', async () => {
  const white=sample([...initial,'b1c3']);
  const invalid: Sample[] = [ {...sample(),pid:43}, {...sample(),windowMarker:'Other'}, {...sample(),documentMarker:'other'}, sample([]),
    sample([...initial,'b1c3','g8f6']), {...white, moves:initial, fen:sample().fen}, {...sample(),placement:'8/8/8/8/8/8/8/8'} ];
  for (const value of invalid) {
    const {c,reports,sends}=rig(); await stable(c,value); await stable(c,value);
    assert.equal(c.state.mode,'paused'); assert.equal(reports.length,1); assert.equal(sends.length,0);
  }
});
test('pause/resume needs fresh stability; stop is terminal', async () => {
  const {c,sends}=rig(); const white=sample([...initial,'b1c3']);
  await c.observe(white); await c.pause('operator'); await c.observe(white); assert.equal(sends.length,0);
  await c.resume(); await c.observe(white); assert.equal(sends.length,0); await c.observe(white); assert.equal(sends.length,1);
  await c.stop(); await c.pause('late control'); await assert.rejects(()=>c.resume()); await stable(c,sample()); assert.equal(c.state.mode,'stopped');
});
test('bootstrap rejects wrong color, history, placement and document', () => {
  for (const value of [{...sample(),placement:'8/8/8/8/8/8/8/8'},{...sample(),documentMarker:'other'},sample([...initial,'b1c3'])]) assert.throws(()=>bootstrap(binding,value));
  assert.throws(()=>bootstrap({...binding,ownerColor:'b' as 'w'},sample()));
});
test('legal validator handles castling, en passant, promotion and rejects pinned movement', () => {
  for (const [fen,lan] of [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','e1g1'],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1','e5d6'],
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1','a7a8n'],
  ]) {
    const chess=new Chess(fen); const m=chess.move({from:lan!.slice(0,2),to:lan!.slice(2,4),promotion:lan![4]});
    assert.equal(uniqueTransition(fen!,chess.fen().split(' ')[0]!).lan,m.lan);
  }
  assert.throws(()=>uniqueTransition('k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1','k3r3/8/8/8/8/8/5R2/4K3'));
});
test('AX decoder uses square identities, rejects duplicates and malformed pieces', () => {
  const names = Array.from({length:64},(_,i)=>`${'abcdefgh'[i%8]}${Math.floor(i/8)+1}`);
  names[0]='white rook, a1'; names[63]='black king, h8';
  assert.equal(placement(names.reverse()),'7k/8/8/8/8/8/8/R7');
  assert.throws(()=>placement(names.slice(1))); assert.throws(()=>placement([...names.slice(1),names[1]!]));
  assert.throws(()=>placement(names.map(n=>n==='white rook, a1'?'white dragon, a1':n)));
  assert.doesNotMatch(AX_SCRIPT,/activate|frontWindow|click|screenshot/);
});
test('atomic state survives replacement and leaves no temporary file', async () => {
  const dir=await mkdtemp(join(tmpdir(),'chess-state-'));
  try { const file=join(dir,'state.json'); await atomicWrite(file,{n:1}); await atomicWrite(file,{n:2});
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{n:2}); assert.deepEqual(await readdir(dir),['state.json']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('signed adapter refuses missing credentials without connection', () => { assert.throws(()=>signedChessWake({})); });
test('terminal White move pauses without requesting an impossible Black response', async () => {
  const moves=['e2e4','e7e5','f1c4','b8c6','d1h5','g8f6'];
  const state=bootstrap({...binding,moves},sample(moves));let sends=0;
  const c=new ChessSession(state,async()=>{},async()=>{sends++;return {state:'running'};},()=>{});
  await stable(c,sample([...moves,'h5f7'])); assert.equal(c.state.mode,'paused'); assert.equal(c.state.reason,'Game over');assert.equal(sends,0);
});
