import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require=createRequire(import.meta.url);
const {GoalCurator}=require('../../../engine/src/goals/goal-curator.js');
const {ClusterAwareMemory}=require('../../../engine/src/cluster/cluster-aware-memory.js');
const logger={info(){},warn(){},error(){},debug(){}};

function fixture() {
  const visited=new Set(),nodes=new Map();
  for(let i=0;i<80;i++){
    const id=`node-${i}`,node={id};
    Object.defineProperty(node,'concept',{enumerable:true,get(){
      visited.add(id);const end=performance.now()+0.15;while(performance.now()<end){}
      return 'Repair graph endpoint';
    }});
    nodes.set(id,node);
  }
  const cluster=new ClusterAwareMemory({nodes,edges:new Map(),clusters:new Map(),persistenceGeneration:0},{logger});
  const memory=cluster.getInterface();
  const goals=[{id:'g1',description:'Repair graph endpoint'},{id:'g2',description:'Repair graph endpoint'}];
  let active=true;
  const curator=new GoalCurator({goals:new Map(goals.map(g=>[g.id,g]))},memory,logger,{},null,{isActive:()=>active});
  curator.gpt5={generateFast(){throw Error('Unexpected provider call')}};
  return {visited,memory,goals,curator,stop(){active=false;}};
}

test('goal bridging yields during a substantial graph scan and preserves stable relevance ties',async()=>{
  const {visited,memory,goals,curator}=fixture();
  const turn=new Promise(resolve=>setImmediate(()=>resolve(visited.size)));
  const scan=curator.bridgeGoalsToMemory(goals);
  assert.ok(await turn<memory.nodes.size,'Goal bridging blocked the whole graph scan');
  await scan;
  assert.deepEqual([...curator.memoryBridges],[['g1',['node-0','node-1','node-2']],['g2',['node-0','node-1','node-2']]]);
});

test('goal bridging discards a graph revision changed during a yield',async()=>{
  const {memory,goals,curator}=fixture();
  const changed=new Promise(resolve=>setImmediate(()=>{memory.nodes.set('node-0',{id:'node-0',concept:'Unrelated material'});resolve();}));
  const scan=curator.bridgeGoalsToMemory(goals);await changed;await scan;
  assert.equal(curator.memoryBridges.size,0);
  await curator.bridgeGoalsToMemory(goals);
  assert.deepEqual(curator.memoryBridges.get('g1'),['node-1','node-2','node-3']);
});

test('goal bridging does not write after its orchestrator stops',async()=>{
  const {goals,curator,stop}=fixture();
  const stopped=new Promise(resolve=>setImmediate(()=>{stop();resolve();}));
  const scan=curator.bridgeGoalsToMemory(goals);await stopped;await scan;
  assert.equal(curator.memoryBridges.size,0);
});

test('goal bridging retains the existing threshold, ranking and ten-goal limit',async()=>{
  const nodes=new Map([
    ['a',{id:'a',concept:'graph'}],['b',{id:'b',concept:'unrelated'}],
    ['c',{id:'c',concept:'graph repair endpoint'}],['d',{id:'d',concept:'graph repair'}],
    ['e',{id:'e',concept:'graph repair'}],['f',{id:'f',concept:'graph repair'}],
  ]);
  const goals=Array.from({length:11},(_,i)=>({id:`g${i}`,description:'graph repair endpoint'}));
  const curator=new GoalCurator({goals:new Map(goals.map(g=>[g.id,g]))},{nodes},logger,{});
  await curator.bridgeGoalsToMemory(goals);
  assert.equal(curator.memoryBridges.size,10);
  assert.deepEqual(curator.memoryBridges.get('g0'),['c','d','e']);
  assert.equal(curator.memoryBridges.has('g10'),false);
});
