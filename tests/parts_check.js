const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8);let checks=0;const test=(name,f)=>{f();checks++;console.log('ok '+name);};
test('recursive dominant parts conserve the partition',()=>{
 const X={}; vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/parts.js`,'utf8'),{window:{TX:X}});
 const parts=X.coarsenParts([[.01,.94,.04,.01,0]],[[1,2,3],[],[],[]],[0],4);
 assert.ok(parts.some(p=>p.node===1)); assert.ok(parts.some(p=>p.node===2));
 assert.deepEqual(Array.from(parts).flatMap(p=>Array.from(p.ks)).sort(),[0,1,2,3,4]);
 for(let n=2;n<100;n++){
  const children=Array.from({length:n},()=>[]);for(let k=1;k<n;k++)children[Math.floor((k-1)/2)].push(k);
  const mean=Array.from({length:3},(_,j)=>{const a=Array.from({length:n+1},(_,k)=>(k*17+j*11)%23);const sum=a.reduce((s,v)=>s+v,0);return a.map(v=>v/sum);});
  const out=X.coarsenParts(mean,children,[0],n);
  assert.deepEqual(Array.from(out).flatMap(p=>Array.from(p.ks)).sort((a,b)=>a-b),Array.from({length:n+1},(_,k)=>k));
 }
});
test('a child significant only in slow compilations gets its own band',()=>{
 const X={}; vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/parts.js`,'utf8'),{window:{TX:X}});
 // CBO is only 38% of its parent across the axis, but crosses 10% of compile time at the slow end.
 const mean=[[.05,.001,.949],[.06,.04,.9],[.06,.11,.83]], children=[[1],[]];
 const out=X.coarsenParts(mean,children,[0],2);
 assert.ok(out.some(p=>p.node===1),'sole significant child must survive without dominating its parent');
 assert.ok(out.some(p=>p.node===0&&p.kind==='own'));
 assert.deepEqual(Array.from(out).flatMap(p=>Array.from(p.ks)).sort(),[0,1,2]);
});
test('recorded smaller steps stay separate from time outside child spans',()=>{
 const X={}; vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/parts.js`,'utf8'),{window:{TX:X}});
 const mean=[[.1,.4,.04,.04,.04,.38]], children=[[1,2,3,4],[],[],[],[]];
 const out=X.coarsenParts(mean,children,[0],5), own=out.find(p=>p.kind==='own'), steps=out.find(p=>p.kind==='steps');
 assert.deepEqual(Array.from(own.ks),[0]);assert.deepEqual(Array.from(steps.ks),[2,3,4]);
 assert.deepEqual(Array.from(out).flatMap(p=>Array.from(p.ks)).sort(),[0,1,2,3,4,5]);
});
test('spare space reveals two small parts while preserving the partition',()=>{
 const X={};vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/parts.js`,'utf8'),{window:{TX:X}});
 const row=[.8,.04,.03,.03,.03,.03,.02,.02,0],parts=X.coarsenParts([row,row],row.map(()=>[]),[0,1,2,3,4,5,6,7],8);
 assert.equal(parts.filter(p=>p.extra).length,2);
 assert.deepEqual(Array.from(parts).flatMap(p=>Array.from(p.ks)).sort(),row.map((_,i)=>i));
 near(parts.reduce((sum,p)=>sum+p.ks.reduce((n,k)=>n+row[k],0),0),1);
 const small=X.coarsenParts([[.93,.04,.03,0]],[[],[],[],[]],[0,1,2],3);
 assert.ok(!small.some(p=>p.extra));
});
console.log(checks+' parts checks passed');
