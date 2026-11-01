const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
global.window = {TX:{}};
vm.runInThisContext(fs.readFileSync(require.resolve('../web/flows.js'),'utf8'));
const critical = require('../web/critical.js');
const run = (rows, links=[]) => { const tree = {rows:rows.flat(), links}; return critical(tree, window.TX.traceFlows(tree)); };
const row = (parent,start,end,flags=0) => {start=Math.round(start*1000)/1000;end=Math.round(end*1000)/1000;return [0,parent,start,end-start,flags];};
const fork = (a,b,work=15) => run([row(-1,0,Math.max(a,b,work)+5), row(0,0,a,5), row(0,0,b,5), row(0,work,Math.max(a,b,work))], [3,1,1,3,2,1]);
let cp = fork(20,10);
assert.deepEqual(cp.reasons, []);
assert.equal(cp.duration,25);
assert.deepEqual(cp.segments.get(1),[[0,20]]);
assert.deepEqual(cp.segments.get(0),[[20,25]]);
assert.equal(cp.segments.has(2),false);
cp = fork(5,10);
assert.equal(cp.segments.has(1),false);
assert.equal(cp.segments.has(2),false);
assert.equal(cp.duration,20); // Parallel work finished before the wait.
cp = run([row(-1,0,30),row(0,0,20,5),row(0,15,24)], [2,1,1]);
assert.equal(cp.duration,30);
assert.deepEqual(cp.segments.get(0),[[20,30]]); // Resumption delay remains.
cp = run([row(-1,0,30),row(0,0,100,5)]);
assert.equal(cp.segments.has(1),false); // Unjoined work cannot hold the root open.
cp = run([row(-1,0,30),row(0,0,25,5),row(0,15,20,2)], [2,1,1]);
assert(cp.reasons.includes('Incomplete or legacy wait'));
assert.equal(cp.duration,30);
cp = run([row(-1,0,30),row(0,15,20,8)]);
assert(cp.reasons.includes('Missing prerequisite spans'));
cp = run([row(-1,0,30),row(0,0,0,5),row(0,0,0,5)], [1,2,2,2,1,2]);
assert(cp.reasons.includes('Cyclic dependencies'));
assert.equal(cp.segments.size,0);
cp = run([row(-1,0,30),row(0,0,10,5),row(0,10,20,5),row(0,15,20)], [2,1,2,3,2,1]);
assert.equal(cp.duration,30);
assert(cp.segments.has(1) && cp.segments.has(2));
// Timing-preserving random fork/join recordings must produce one non-overlapping path covering the root.
let seed = 19281;
const random = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
for (let trial=0; trial<10000; trial++) {
  const rows = [row(-1,0,1)], links = [];
  let time = 0;
  for (let phase=0; phase<1+random()*8; phase++) {
    const targets = [], count = 1+Math.floor(random()*8), work = time+random()*20;
    let ready = work;
    for (let k=0; k<count; k++) {
      const a = time+random()*(work-time), b = a+random()*30;
      targets.push(rows.length); rows.push(row(0,a,b,5)); ready = Math.max(ready,b);
    }
    const wait = rows.length; rows.push(row(0,work,ready));
    for (const target of targets) links.push(wait,target,1);
    time = ready+random()*10;
  }
  time = Math.round(time*1000)/1000;
  rows[0][3] = time;
  const result = run(rows,links), path = [...result.segments.values()].flat().sort((a,b)=>a[0]-b[0]);
  assert.deepEqual(result.reasons,[]);
  assert(Math.abs(result.duration-time)<1e-8);
  assert(Math.abs(path.reduce((sum,[a,b])=>sum+b-a,0)-time)<1e-8);
  for (let k=1; k<path.length;k++) assert(Math.abs(path[k][0]-path[k-1][1])<1e-8);
}
const big = [row(-1,0,100000)];
for(let i=0;i<100000;i++) big.push(row(0,i,i+1));
const began = performance.now(); cp = run(big);
assert.equal(cp.vertices,2);
console.log(`Critical path: fixtures + 10,000 fork/join fuzz cases; 100,001 spans in ${(performance.now()-began).toFixed(1)} ms`);
