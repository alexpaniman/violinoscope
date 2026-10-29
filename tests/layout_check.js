// Run the real layout model against small traces with independently known timings.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../web/layout.js`, 'utf8');
const sep = '\u0001', copy = (s) => '\u0002' + s;
function fixture(extra = {}) {
  const names = extra.names || ['Compile', 'Prepare', 'Annotate IO', 'Optimize', 'Annotate KQL', 'Other', 'Wait', 'Async', 'Async child'];
  const rows = extra.rows || [0,-1,0,100000,1, 1,0,0,60000,0, 2,1,10000,10000,0, 5,1,25000,5000,0,
    3,0,60000,40000,0, 4,4,65000,5000,0, 6,4,80000,20000,0, 7,0,20000,80000,1, 8,7,30000,10000,0];
  const count = extra.count || 1, events = new Map(), data = {units:Array.from({length:count},()=>({ms:100,k:0}))};
  const X = {data, meta:{unit:'Compile',chunk:count}, NU:count, GRID:1000, ROOT:'~root', ROOT2:'~two', checkLayout:true,
    chunk:()=>({names,trees:Array.from({length:count},()=>({rows,links:extra.links || []}))}), on:(n,f)=>events.set(n,f), emit:()=>{}, render:()=>{}, tokens:()=>{},
    reindex:()=>{data.columnIndex = new Map(data.columns.map((c,k)=>[c.id,k]));}};
  const context = {window:{TX:X},localStorage:{getItem:()=>null,setItem:()=>{}}};
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/flows.js`, 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../web/definition-model.js`, 'utf8'), context);
  vm.runInNewContext(source, context);
  events.get('chunk')(0);
  const T=X.layout, path=(...xs)=>xs.join(sep), root='Compile';
  return {X,T,root,a:path(root,'Prepare'),b:path(root,'Optimize'),x:path(root,'Prepare','Annotate IO'),
    y:path(root,'Optimize','Annotate KQL'),z:path(root,'Prepare','Other'),async:path(root,'Async')};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);
let checks=0;
function test(name, run) {console.log(`start ${name}`); run(); checks++; console.log(`ok ${name}`);}
test('extraction transfers time and leaves root unchanged',()=>{
 const {T,root,a,b,x,y}=fixture(); T.add([x,y]); const g=T.merge([x,y],'Annotations');
 near(T.msOf(a)[0],50); near(T.msOf(b)[0],35); near(T.msOf(g)[0],15); near(T.msOf(root)[0],100);
 T.collapse(g); near(T.msOf(a)[0],50); T.hide(x); near(T.msOf(g)[0],15); T.check();
 T.ungroup(g); near(T.msOf(a)[0],60); near(T.msOf(b)[0],40);
});
test('merge retains operands and their exclusions',()=>{
 const {T,a,b,x,y,z}=fixture(); T.exclude(a,[x]); const first=T.merge([a,b],'Phases');
 near(T.msOf(first)[0],90); assert.ok(T.members(first).includes(a));
 T.hide(a); near(T.msOf(first)[0],90); T.add([a]); near(T.msOf(a)[0],50);
 T.fresh(); const inner=T.merge([x,z],'Inner'); T.exclude(inner,[x]); near(T.msOf(inner)[0],5);
 const outer=T.merge([inner,y],'Outer'); assert.ok(T.members(outer).includes(inner)); near(T.msOf(outer)[0],10);
 T.hide(inner); assert.ok(T.isMerged(inner)); near(T.msOf(outer)[0],10); T.add([inner]); T.check();
});
test('projections are independent, moving changes ownership',()=>{
 const {T,a,b,x,y,root}=fixture(); const g=T.merge([x,y],'Annotations'); const c=T.copyOver(g);
 near(T.msOf(c)[0],15); T.hide(g); near(T.msOf(a)[0],50); near(T.msOf(b)[0],35);
 const moved=T.transfer(c,root); near(T.msOf(a)[0],50); near(T.msOf(b)[0],35); assert.equal(moved,c);
 const back=T.transfer(moved,'~two'); near(T.msOf(a)[0],60); near(T.msOf(back)[0],15); T.check();
});
test('hidden groups remain definitions, restore and roundtrip without changing time',()=>{
 const {T,X,a,b,x,y,root}=fixture(); T.add([x,y]); const g=T.merge([x,y],'Annotations');
 const times=[a,b,g,root].map(id=>T.msOf(id)[0]); T.hide(g);
 assert.ok(T.isMerged(g)); assert.ok(T.candidates(root,'Annotations').some(r=>r.id===g));
 assert.ok(!X.data.columns.some(c=>c.id===g)); assert.ok(X.data.columns.some(c=>c.id===x));
 assert.deepEqual([a,b,g,root].map(id=>T.msOf(id)[0]),times);
 const saved=JSON.stringify(T.state()); T.load(T.state()); assert.equal(JSON.stringify(T.state()),saved);
 T.add([g]); assert.ok(T.shown(g)); assert.equal(T.parentOf(x),g); T.check();
});
test('copies keep transferred holes and independent later edits',()=>{
 const {T,a,x,y}=fixture();const g=T.merge([x,y],'Extracted'),c=T.copyOver(a);
 near(T.msOf(a)[0],50);near(T.msOf(c)[0],50);
 T.exclude(g,[x]);near(T.msOf(a)[0],60);near(T.msOf(c)[0],50);
 T.load(T.state());near(T.msOf(c)[0],50);T.check();
});
test('copy preserves a transferred definition with excluded descendants',()=>{
 const {T}=fixture({names:['Compile','P','A','X','B'],rows:[0,-1,0,100000,1,1,0,0,80000,0,2,1,0,60000,0,3,2,10000,20000,0,4,0,80000,10000,0]});
 const p='Compile'+sep+'P',a=p+sep+'A',x=a+sep+'X',b='Compile'+sep+'B';
 T.exclude(a,[x]);T.merge([a,b],'Extracted');near(T.msOf(p)[0],40);
 const c=T.copyOver(p);near(T.msOf(c)[0],40);T.check();
});
test('a group retains its placement when its other branch is removed',()=>{
 const {T,a,x,y,root}=fixture();const g=T.merge([x,y],'Both');T.leave(y,g);
 assert.equal(T.parentOf(g),root);near(T.msOf(a)[0],50);near(T.msOf(g)[0],10);T.check();
});
test('extracted projection inputs retain their former containing bounds',()=>{
 const {T}=fixture({names:['Compile','H','P','A','Q'],rows:[0,-1,0,100000,1,1,0,0,100000,0,2,1,0,60000,0,3,2,0,70000,0,4,1,80000,10000,0]});
 const h=T.copyOver('Compile'+sep+'H'),p=T.kids(h).find(k=>T.spanName(k)==='P'),q=T.kids(h).find(k=>T.spanName(k)==='Q'),a=T.kids(p)[0];
 near(T.msOf(a)[0],60);const g=T.merge([a,q],'Parts');near(T.msOf(g)[0],70);near(T.msOf(a)[0],60);T.check();
});
test('merge preserves exclusions inherited from the parent it leaves',()=>{
 const {T}=fixture({names:['Compile','P','A','X','B'],rows:[0,-1,0,100000,1,1,0,0,80000,0,2,1,0,60000,0,3,2,10000,20000,0,4,0,80000,10000,0]});
 const p='Compile'+sep+'P',a=p+sep+'A',x=a+sep+'X',b='Compile'+sep+'B';
 T.exclude(p,[x]);near(T.msOf(a)[0],40);const g=T.merge([a,b],'Together');
 near(T.msOf(g)[0],50);near(T.msOf(a)[0],40);near(T.msOf(p)[0],20);
 assert.ok(T.excluded(p).includes(x));assert.ok(T.excluded(a).includes(x));T.check();
});
test('exclude cuts overlapping coverage supplied by another input',()=>{
 const {T}=fixture({names:['Compile','A','B'],rows:[0,-1,0,100000,1,1,0,0,60000,0,2,0,40000,40000,0]});
 const a='Compile'+sep+'A',b='Compile'+sep+'B',g=T.merge([a,b],'Overlap');near(T.msOf(g)[0],80);
 T.exclude(g,[a]);near(T.msOf(g)[0],20);assert.ok(T.excluded(g).includes(a));T.check();
});
test('taking a part out propagates through derived ancestors and keeps empty definitions',()=>{
 const {T,x,y,z}=fixture();const g=T.merge([x,y],'Inner'),h=T.merge([g,z],'Outer');
 T.leave(x,g);near(T.msOf(g)[0],5);near(T.msOf(h)[0],10);assert.ok(!T.members(h).includes(x));
 T.leave(y,g);near(T.msOf(g)[0],0);near(T.msOf(h)[0],5);assert.ok(T.isMerged(g));
 const s=JSON.stringify(T.state());T.load(T.state());assert.equal(JSON.stringify(T.state()),s);T.check();
});
test('snapshot undo and redo restore exact definitions and display',()=>{
 const {T,x,y}=fixture(); const before=JSON.stringify(T.state()); T.merge([x,y],'Named'); const after=JSON.stringify(T.state());
 T.undo(); assert.equal(JSON.stringify(T.state()),before); T.redo(); assert.equal(JSON.stringify(T.state()),after);
 const state=T.state(); T.load(state); assert.equal(JSON.stringify(T.state()),after);
 state.groups[0][2].pop(); assert.notEqual(JSON.stringify(T.state()),JSON.stringify(state)); T.check();
});
test('async work keeps its duration and never takes awaited time',()=>{
 const {X,T,a,b,async}=fixture(); const before=Array.from(X.data.units[0].p);
 T.add([copy(async)],'~two'); near(T.msOf(copy(async))[0],80); near(T.msOf(a)[0],60); near(T.msOf(b)[0],40);
 assert.deepEqual(Array.from(X.data.units[0].p),before); assert.equal(T.destinations(copy(async)).length,0); T.check();
});
test('excluded paths return outside their excluding parent',()=>{
 const {T,a,x,root}=fixture(); T.add([x]); T.exclude(a,[x]); assert.equal(T.parentOf(x),root);
 assert.ok(!T.candidates(a,'').some((r)=>r.id===x)); T.add([x]); near(T.msOf(a)[0],50); near(T.msOf(x)[0],10); T.check();
});
test('large projections preserve coverage through expansion, exclusions and undo',()=>{
 const names=['Compile'], rows=[0,-1,0,100000,0];
 for(let k=1;k<=8;k++){names.push(`Phase ${k}`);rows.push(k,k-1,0,75000,0);}
 for(let k=0;k<75;k++) {
  const parent=names.length;names.push(`Branch ${k}`,'Compute properties');
  rows.push(parent,8,k*1000,1000,0,parent+1,parent,k*1000+100,200,0);
 }
 const {X,T}=fixture({names,rows,count:1500}), before=X.data.units.map(u=>Array.from(u.p));
 const ids=T.candidates(X.ROOT2,'Compute properties').map(c=>c.id);assert.equal(ids.length,75);
 let start=performance.now();const group=T.merge(ids,'Properties');const addMs=performance.now()-start;
 assert.ok(T.msOf(group).every(v=>Math.abs(v-15)<1e-8));
 start=performance.now();T.expand(group);const expandMs=performance.now()-start;
 assert.ok(T.msOf(group).every(v=>Math.abs(v-15)<1e-8));
 T.add(ids,group);assert.equal(X.data.columns.filter(c=>c.second).length,76);
 T.collapse(group);T.expand(group);
 T.exclude(group,[ids[0]]);assert.ok(T.msOf(group).every(v=>Math.abs(v-14.8)<1e-8));
 T.undo();assert.ok(T.msOf(group).every(v=>Math.abs(v-15)<1e-8));
 assert.deepEqual(X.data.units.map(u=>Array.from(u.p)),before);T.check();
 console.log(`75 parts / 1500 units: add ${Math.round(addMs)} ms, expand ${Math.round(expandMs)} ms`);
 if(process.env.CHECK_PERFORMANCE) {
  assert.ok(addMs<3000,`Adding a projection blocked for ${Math.round(addMs)} ms`);
  assert.ok(expandMs<3000,`Opening a projection blocked for ${Math.round(expandMs)} ms`);
 }
});
test('random edit sequences preserve invariants and undo each change',()=>{
 for(let seed=1;seed<=Number(process.env.FUZZ_SEEDS || 50);seed++) {
  const {T,X,x,y,z,a,b}=fixture(); let n=seed;
  const rand=(k)=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return (n>>>8)%k;};
  for(let step=0;step<100;step++) {
   const ids=X.data.columns.map(c=>c.id), id=ids[rand(ids.length)], op=rand(16), before=JSON.stringify(T.state());
   if (process.env.DEBUG_LAYOUT) console.log(seed, step, op, id);
   if(op===0) T.add([[x,y,z,a,b][rand(5)]]);
   else if(op===1&&id) T.expand(id);
   else if(op===2&&id) T.collapse(id);
   else if(op===3&&id) T.hide(id);
   else if(op===4) {const pairs=ids.filter(j=>id&&T.canMerge(id,j));if(pairs.length)T.merge([id,pairs[rand(pairs.length)]],'Group');}
   else if(op===5&&id) {const r=T.spansFor(id,'','exclude');if(r.length)T.exclude(id,[r[rand(r.length)].id]);}
   else if(op===6&&id) T.rename(id,`Name ${step}`);
   else if(op===7&&id&&T.isMerged(id)) T.ungroup(id);
   else if(op===8&&id) T.copyOver(id);
   else if(op===9&&id) {const ds=T.destinations(id);if(ds.length){const dest=ds[rand(ds.length)].id; if(process.env.DEBUG_LAYOUT)console.log('transfer',id,dest,JSON.stringify(T.state()));T.transfer(id,dest);}}
   else if(op===10&&id) {const ms=T.members(id);if(T.isMerged(id)&&ms.length)T.leave(ms[rand(ms.length)],id);}
   else if(op===11&&id) {const ms=T.excluded(id);if(ms.length)T.unexclude(id,ms[rand(ms.length)]);}
   else if(op===12&&id) {const cs=T.spansFor(id,'Annotate','include');if(cs.length)T.include(id,[cs[rand(cs.length)].id]);}
   else if(op===13&&id&&T.promotable(id))T.promote(id);
   else if(op===14&&id) {const siblings=ids.filter(x=>x!==id&&T.parentOf(x)===T.parentOf(id));if(siblings.length)T.move(id,siblings[rand(siblings.length)],true);}
   else if(op===15&&id) {const skipped=T.skippedAbove(id);if(skipped.length)T.unskip(skipped[0]);}
   T.check();
   if(step%20===0){const d=T.breakdown();assert.equal(new Set(d.nodes.map(n=>n.id)).size,d.nodes.length);near(d.rows[0].reduce((s,v)=>s+v,0),1);assert.ok(d.rows[0].every(v=>Number.isFinite(v)&&v>=0));}
   const after=JSON.stringify(T.state());
   if(before!==after){T.undo();assert.equal(JSON.stringify(T.state()),before,`seed ${seed} step ${step} op ${op}`);T.redo();assert.equal(JSON.stringify(T.state()),after);}
  }
 }
});

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

test('full breakdown is independent of visibility and respects transfers and exclusions',()=>{
 const {T,X,root,a,b,x,y,z,async}=fixture();
 const own=(d,id)=>d.rows[0][d.nodes.findIndex(n=>n.id===id)]*100;
 const total=(d,id)=>{const k=d.nodes.findIndex(n=>n.id===id),walk=j=>d.rows[0][j]+d.children[j].reduce((s,c)=>s+walk(c),0);return walk(k)*100;};
 let d=T.breakdown();near(own(d,a),45);near(own(d,b),15);near(own(d,x),10);near(total(d,root),100);
 assert.ok(!d.nodes.some(n=>n.id===async));
 T.expand(a);T.hide(x);assert.equal(T.breakdown(),d,'display changes must reuse the measured breakdown');
 const g=T.merge([x,y],'Annotations');d=T.breakdown();near(total(d,g),15);near(total(d,a),50);near(total(d,b),35);
 T.exclude(g,[x]);d=T.breakdown();near(total(d,g),5);near(total(d,root),100);near(own(d,x),0);near(total(d,a),60);
 T.rename(z,'Renamed small step');assert.ok(T.breakdown().nodes.some(n=>n.label==='Renamed small step'));
 T.hide(a);d=T.breakdown();near(own(d,a),55);near(total(d,root),100);
 near(d.rows[0].reduce((s,v)=>s+v,0),1);
});

test('full breakdown applies intersecting main and projection what-if factors exactly',()=>{
 const {T,X,a,x}=fixture();T.add([x]);const p=T.copyOver(x);T.add([p],'~two');
 X.depthIdx=X.data.columns.map(c=>{let n=0;for(let id=c.id;id;id=T.parentOf(id))n++;return n;});
 const eff=X.data.columns.map(c=>c.id===a?.5:c.id===x?.5:c.id===p?.5:1);
 X.proj=()=>({eff});X.scenarioKey=()=> 'test';
 const d=T.breakdown(),row=d.rows[0],at=id=>d.nodes.findIndex(n=>n.id===id);
 near(row[at(x)],.025);near(row[at(a)],.225);near(row.reduce((s,v)=>s+v,0),.675);
});



test('moving a span preserves its edited descendants',()=>{
 const {T,a,x,z}=fixture(); T.add([x,z]);T.rename(x,'Renamed annotation');T.exclude(x,[]);
 const c=T.transfer(a,'~two'), child=T.kids(c).find(id=>T.sourceKey(id)===x); assert.equal(T.label(child),'Renamed annotation');assert.ok(T.shown(child));
 const moved=T.transfer(c,'Compile');assert.equal(moved,a);assert.equal(T.label(x),'Renamed annotation');assert.ok(T.shown(x));T.check();
});
test('legacy async groups migrate without stealing elapsed time',()=>{
 const {T,X,a,async}=fixture();T.load({v:2,groups:[['g1','Mixed',[a,async]]],shown:['g1'],open:['g1']});
 assert.ok(X.data.columns.every(c=>c.second||!c.async));near(T.msOf('g1')[0],60);T.check();
});


test('an excluded descendant can be a separate merge operand',()=>{
 const {T,a,b,x}=fixture();T.exclude(a,[x]);assert.ok(T.canMerge(a,x));
 const g=T.merge([a,b],'Minus annotation');near(T.msOf(g)[0],90);assert.ok(T.canMerge(g,x));
 const both=T.merge([g,x],'Whole');near(T.msOf(both)[0],100);assert.ok(T.members(both).includes(g));near(T.msOf(a)[0],50);T.check();
});


test('async migration respects an existing projection membership',()=>{
 const {T,a,b,async}=fixture();T.load({v:2,groups:[['g1','Mixed',[a,async]],['g2','Projection',[copy(async),copy(b)],{tree:2}]],shown:['g1','g2'],open:[]});
 near(T.msOf('g1')[0],60);assert.ok(T.members('g2').some(id=>T.sourceKey(id)===async));T.check();
});
test('independent projections retain overlapping inputs and separate edits',()=>{
 const {T,x,y,z}=fixture(); const a=T.merge([copy(x),copy(y)],'First'),b=T.merge([copy(y),copy(z)],'Second');
 near(T.msOf(a)[0],15);near(T.msOf(b)[0],10);assert.equal(T.members(a).length,2);
 assert.ok(!T.members(a).some(id=>T.members(b).includes(id)));
 T.exclude(b,[copy(y)]);near(T.msOf(a)[0],15);near(T.msOf(b)[0],5);
 const saved=JSON.stringify(T.state());T.load(T.state());assert.equal(JSON.stringify(T.state()),saved);
 near(T.msOf(a)[0],15);near(T.msOf(b)[0],5);T.check();
});
test('independent projection factors multiply and do not depend on display',()=>{
 const {T,X,a}=fixture(),first=T.copyOver(a),factors=new Map([[first,.5]]);
 near(T.project(factors).total[0],70);
 const second=T.copyOver(a);near(T.project(factors).total[0],70);
 const k1=X.data.columns.findIndex(c=>c.id===first),k2=X.data.columns.findIndex(c=>c.id===second);
 near(X.data.units[0].o[k1],.6);near(X.data.units[0].o[k2],.6);
 factors.set(second,.5);near(T.project(factors).total[0],55);
 T.move(first,second,true);near(T.project(factors).total[0],55);
 T.hide(first);near(T.project(factors).total[0],55);assert.ok(T.scenarioActive(factors));
 const projection=T.project(factors);X.proj=()=>projection;X.scenarioKey=()=>T.scenarioKey(factors);
 near(T.breakdown().rows[0].reduce((a,b)=>a+b,0),.55);
});
test('missing sources remain editable zero-valued inputs',()=>{
 const {T,root,x}=fixture(),missing=root+sep+'Future phase';
 T.load({v:5,groups:[['g1','Reusable',[x,missing]]],shown:['g1']});
 assert.ok(T.members('g1').includes(missing));near(T.msOf(missing)[0],0);assert.equal(T.hasPath(missing),false);
 T.leave(missing,'g1');const state=T.state();T.load(state);assert.ok(!T.members('g1').includes(missing));T.check();
});
test('overlap attribution is independent of displayed row order and names',()=>{
 const {T}=fixture({names:['Compile','A','B'],rows:[0,-1,0,100000,1,1,0,0,60000,0,2,0,40000,40000,0]});
 const a='Compile'+sep+'A',b='Compile'+sep+'B';
 const values=()=>{const d=T.breakdown();return Object.fromEntries(d.nodes.map((n,k)=>[n.id,d.rows[0][k]]));};
 const before=values();T.move(a,b,true);T.rename(a,'ZZZ');assert.deepEqual(values(),before);
});
test('invalid imports reject ownership cycles without changing the layout',()=>{
 const {T}=fixture(),before=JSON.stringify(T.state());
 assert.throws(()=>T.load({v:5,groups:[['g1','A',['g2']],['g2','B',['g1']],['g3','C',['g1']]]}),/owner|cycle/);
 assert.equal(JSON.stringify(T.state()),before);
});
function dependencyFixture() {
 const f=fixture({names:['Compile','Prepare','Dependency batch','Request A','Decode','Request B'],
  rows:[0,-1,0,100000,1, 1,0,0,60000,0, 2,1,10000,70000,1, 3,2,10000,45000,1,
    4,3,20000,10000,0, 5,2,30000,100000,1], links:[2,3,1,2,5,1]});
 const join=[f.root,'Prepare','Dependency batch'].join(sep);
 return {...f,join,job:join+sep+'Request A',child:join+sep+'Request A'+sep+'Decode',late:join+sep+'Request B'};
}
test('flow boundaries inherit through ordinary descendants and dependency detection uses links',()=>{
 const {X}=dependencyFixture();
 const tree={rows:[0,-1,0,100,1, 0,0,0,100,1, 0,1,0,100,0, 0,2,0,100,1, 0,3,0,100,1],links:[3,4,1]};
 const flow=X.traceFlows(tree);
 assert.deepEqual(Array.from(flow.root),[0,1,1,3,4]);assert.deepEqual(Array.from(flow.depth),[0,0,1,0,0]);
 assert.deepEqual(Array.from(flow.main),[1,0,0,0,0]);assert.equal(flow.dependency[3],1);
 // An unrelated dependency and a follows_from edge do not establish a child dependency group.
 assert.equal(X.traceFlows({rows:tree.rows,links:[1,2,1,1,4,1]}).dependency[1],0);
 assert.equal(X.traceFlows({rows:tree.rows,links:[3,4,2]}).dependency[3],0);
});
test('dependency coverage returns to its phase, clips its tail, and leaves requests independent',()=>{
 const {T,X,root,a,join,job,child,late}=dependencyFixture();T.add([join]);
 assert.equal(T.parentOf(join),a);assert.ok(T.async(join)&&T.dependency(join)&&!T.independent(join));
 near(T.msOf(join)[0],50);near(T.msOf(a)[0],60);near(T.msOf(root)[0],100);
 for(const id of [job,child,late]) {assert.ok(T.independent(id));assert.equal(T.destinations(copy(id)).length,0);}
 near(T.msOf(copy(join))[0],70);near(T.msOf(copy(late))[0],100);near(T.msOf(copy(child))[0],10);
 const d=T.breakdown(),own=id=>d.rows[0][d.nodes.findIndex(n=>n.id===id)]*100;
 near(own(a),10);near(own(join),50);near(own(root),40);near(d.rows[0].reduce((s,v)=>s+v,0),1);
 assert.ok(!d.nodes.some(n=>n.id===job||n.id===child));
 T.collapse(a);near(T.msOf(join)[0],50);T.exclude(a,[join]);near(T.msOf(a)[0],10);near(T.msOf(join)[0],50);
 const g=T.merge([a,join],'Whole phase');near(T.msOf(g)[0],60);T.check();
 assert.ok(X.data.columns.every(c=>c.second||!c.independent));
});
test('old layouts restore dependency groups but new hiding and undo remain exact',()=>{
 const {T,X,root,a,join}=dependencyFixture();
 T.load({v:3,shown:[root,a],open:[root]});assert.ok(X.data.columns.some(c=>c.id===join));
 T.hide(join);const hidden=JSON.stringify(T.state());T.load(T.state());assert.equal(JSON.stringify(T.state()),hidden);
 assert.ok(!X.data.columns.some(c=>c.id===join));T.add([join]);T.undo();assert.equal(JSON.stringify(T.state()),hidden);
 T.redo();assert.ok(X.data.columns.some(c=>c.id===join));T.check();
});
test('dependency coverage inherits a whole-phase what-if even when shown',()=>{
 const {T,X,a,join}=dependencyFixture();T.add([join]);
 X.depthIdx=X.data.columns.map(c=>{let n=0;for(let id=c.id;id;id=T.parentOf(id))n++;return n;});
 const eff=X.data.columns.map(c=>!c.second&&(c.id===a||c.id===join)?.5:1);
 X.proj=()=>({eff});X.scenarioKey=()=> 'dependency test';
 const d=T.breakdown(),row=d.rows[0],at=id=>d.nodes.findIndex(n=>n.id===id);
 near(row[at(join)],.25);near(row[at(a)],.05);near(row.reduce((s,v)=>s+v,0),.7);
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
console.log(`${checks} model checks passed`);
