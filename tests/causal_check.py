#!/usr/bin/env python3
"""Generic spawn/wait spans across conversion, allocation and the waterfall."""
import asyncio
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, opened
from synth import Trace

ROOT = Path(__file__).resolve().parents[1]


async def main():
    errors = []
    with tempfile.TemporaryDirectory(prefix='violinoscope-causal-') as folder:
        folder = Path(folder)
        trace = Trace(random.Random(42),42)
        base = 1700000000000000000
        def span(name,parent,a,b,spawn=False):
            return trace.span(name,parent,base+a*1000000,base+b*1000000,
                              {'parent.relation':'spawn'} if spawn else None)
        root = span('Request','',0,100)
        phase = span('Prepare',root,0,60)
        job = span('Load',phase,10,55,True)
        span('Decode',job,20,30)
        wait = span('Wait',phase,30,60)
        trace.spans[-1]['links'] = [{'traceId':trace.trace_id,'spanId':job,'attributes':[
            {'key':'link.relation','value':{'stringValue':'depends_on'}}]}]
        span('Finish',root,60,100)
        file = folder/'trace.jsonl'
        file.write_text('\n'.join(map(json.dumps,trace.spans)))
        subprocess.run([sys.executable,str(ROOT/'violinoscope.py'),str(file),'-o',str(folder/'report.html')],check=True,capture_output=True)
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=ARGS)
            page = await opened(browser,(folder/'report.html').as_uri(),errors)
            got = await page.evaluate('''()=>{
              const X=TX,T=X.layout,r=X.rawSpans(0),f=r.flat;
              const named=name=>Array.from({length:f.length/5},(_,k)=>k).find(k=>r.names[f[k*5]]===name);
              const phase=T.add(['~pick:Prepare'],T.rootKey())[0],wait=T.add(['~pick:Wait'],phase)[0];
              const cp=X.criticalPath(r.tree,r.flow);
              return {waitMain:r.flow.main[named('Wait')],loadMain:r.flow.main[named('Load')],
                decodeRoot:r.flow.root[named('Decode')],load:named('Load'),
                phase:T.msOf(phase)[0],wait:T.msOf(wait)[0],path:[...cp.segments],reasons:cp.reasons};
            }''')
            assert got['waitMain']==1 and got['loadMain']==0,got
            assert got['decodeRoot']==got['load'],got
            assert got['phase']==60 and got['wait']==30,got
            assert got['reasons']==[],got
            assert [got['load'],[[10000,55000]]] in got['path'],got
            await page.evaluate("TX.go('timeline','waterfall')")
            await page.click('.tl-critical-toggle')
            await page.wait_for_function("document.querySelectorAll('.tl-critical').length>0")
            await page.click('[data-level="none"]')
            assert await page.locator('.tl-row.root .tl-critical').count()==1
            widths = await page.locator('.tl-row.root').evaluate("e=>[e.querySelector('.tl-bar'),e.querySelector('.tl-critical')].map(s=>parseFloat(s.style.width))")
            assert abs(widths[0]-widths[1])<.01,widths
            await page.click('[data-level="all"]')
            before = await page.locator('.tl-row').count()
            await page.evaluate('TX.nav.set(20,40)')
            await page.wait_for_timeout(100)
            assert await page.locator('.tl-row').count()==before
            assert not errors,errors
            await browser.close()
    print('Generic causal spans: conversion, inherited flows, await allocation and critical waterfall passed')


if __name__=='__main__': asyncio.run(main())
