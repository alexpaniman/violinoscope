#!/usr/bin/env python3
"""Measure real report load and a 75-input projection; write a JSON audit."""
import argparse
import asyncio
import json
import time
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, READY


async def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('page');ap.add_argument('--output',default='/tmp/violinoscope-performance.json')
    args=ap.parse_args();errors=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(args=ARGS+['--enable-precise-memory-info'])
        page=await browser.new_page(viewport={'width':1600,'height':1000})
        page.on('pageerror',lambda e:errors.append(str(e)))
        start=time.monotonic();await page.goto(Path(args.page).resolve().as_uri());await page.wait_for_function(READY,timeout=120000)
        load_ms=round((time.monotonic()-start)*1000)
        result=await page.evaluate("""() => {
          const T=TX.layout,before=T.state(),groups=before.groups.map(g=>[g[0],T.size(g[0])]);
          const ids=T.candidates(TX.ROOT2,'Compute').slice(0,75).map(r=>r.id);
          if(ids.length<75)throw Error('Performance fixture needs 75 Compute paths');
          const measured={};let at=performance.now();const g=T.merge(ids,'Performance sample');measured.addMs=performance.now()-at;
          at=performance.now();T.expand(g);measured.expandMs=performance.now()-at;
          at=performance.now();T.add(T.members(g),g);measured.showAllMs=performance.now()-at;
          T.check();if(groups.some(([id,n])=>T.size(id)!==n))throw Error('Another projection lost inputs');
          at=performance.now();TX.setFactor(g,.5);measured.whatIfMs=performance.now()-at;
          TX.layout.clearFactors();T.load(before);
          const spans=Array.from({length:TX.chunkCount},(_,k)=>TX.chunk(k).trees.reduce((n,t)=>n+t.rows.length/5,0)).reduce((a,b)=>a+b,0);
          let paths=0;while(T.path(paths))paths++;
          return {...measured,spans,units:TX.NU,paths,inputs:ids.length};
        }""")
        session=await page.context.new_cdp_session(page)
        await session.send('HeapProfiler.collectGarbage')
        result['heapMiB']=await page.evaluate('Math.round(performance.memory.usedJSHeapSize/2**20)')
        result.update(loadMs=load_ms,errors=errors,browser=browser.version)
        Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,indent=2));await browser.close()
    assert not errors,errors


asyncio.run(main())
