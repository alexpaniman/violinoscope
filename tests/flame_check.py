#!/usr/bin/env python3
"""The full profile, callers and callees share selection, navigation and deep rows."""
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

ROOT=Path(__file__).resolve().parents[1]


def fixture(folder):
    file=folder/'spans.jsonl'
    with file.open('w') as out:
        for i in range(8):
            trace=Trace(random.Random(i),i)
            base=1_700_000_000_000_000_000+i*150_000_000
            def span(name,parent,start,end):
                return trace.span(name,parent,base+int(start*1_000_000),base+int(end*1_000_000))
            unit=span('Request','',0,100)
            for name,start,end in [('Left',0,40),('Right',40,100)]:
                parent=span(name,unit,start,end)
                shared=span('Shared',parent,start+5,end-5)
                span('Alpha',shared,start+6,start+16)
                deep=span('Beta',shared,start+18,end-6)
                if name=='Left':
                    for k in range(48): deep=span(f'Deep {k:02}',deep,19,33)
            for item in trace.spans: out.write(json.dumps(item)+'\n')
    subprocess.run([sys.executable,str(ROOT/'violinoscope.py'),str(file),'--unit','Request','-o',str(folder/'out')],check=True,capture_output=True)
    return (folder/'out/index.html').as_uri()


async def bar_point(page, name):
    return await page.evaluate('''name=>{
      const h=TX.flame.profileModel(),r=h.sync.rects.find(r=>r.node.name===name),[a,b]=TX.flame.heavyWindow(),
        box=document.querySelector('#flame').getBoundingClientRect();
      if(!r) throw Error(JSON.stringify({name,mode:TX.S.prof,focus:h.focus,side:TX.S.side,groups:TX.data.groups,inView:TX.allInView(),names:h.sync.rects.map(r=>r.node.name)}));
      return [box.left+16+((r.x0+r.x1)/2-a)/(b-a)*(box.width-36),box.top+TX.contentTop()+26+8+r.depth*15+7];
    }''',name)


async def main():
    errors=[]
    with tempfile.TemporaryDirectory(prefix='violinoscope-flame-') as tmp:
        url=fixture(Path(tmp))
        async with async_playwright() as p:
            browser=await p.chromium.launch(args=ARGS)
            page=await opened(browser,url,errors)
            await page.emulate_media(color_scheme='dark')
            for mode in ['flame','callers','callees']:
                await page.evaluate("mode=>{TX.select(null);TX.spans.pick('Shared');TX.go('profile',mode);}",mode)
                await page.wait_for_timeout(150)
                assert await page.locator('#flame').is_visible()
                assert await page.locator('#overview').is_visible()
                assert await page.locator('#spans').is_hidden()
                assert await page.locator('#prof-modes [data-prof=callers]').inner_text()=='Callers'
                assert await page.locator('#prof-modes [data-prof=callees]').inner_text()=='Callees'
                anchor=await page.evaluate('TX.flame.profileModel().focus || null')
                original=await page.evaluate('TX.flame.heavyWindow()')
                target='Right' if mode in ('flame','callers') else 'Alpha'
                pt=await bar_point(page,target)
                # Single click selects without zooming or changing the focused root.
                await page.mouse.click(*pt);await page.wait_for_timeout(100)
                assert await page.evaluate('TX.S.name')==target
                await page.wait_for_function('expected=>TX.flame.heavyWindow().every((x,i)=>Math.abs(x-expected[i])<1e-9)',arg=original,timeout=5000)
                assert await page.evaluate('TX.flame.profileModel().focus || null')==anchor
                # Double-click zooms to the very same bar, in every profile mode.
                await page.mouse.dblclick(*pt);await page.wait_for_timeout(300)
                zoomed=await page.evaluate('TX.flame.heavyWindow()')
                assert zoomed[1]-zoomed[0]<original[1]-original[0],(mode,zoomed,original)
                await page.keyboard.press('Escape');await page.wait_for_timeout(300)
                await page.wait_for_function('expected=>TX.flame.heavyWindow().every((x,i)=>Math.abs(x-expected[i])<1e-9)',arg=original,timeout=5000)
                await page.keyboard.press('w');await page.wait_for_timeout(100)
                zoomed=await page.evaluate('TX.flame.heavyWindow()')
                assert zoomed[1]-zoomed[0]<original[1]-original[0]
                await page.keyboard.press('d');await page.wait_for_timeout(100)
                assert await page.evaluate('TX.flame.heavyWindow()[0]')>zoomed[0]
                await page.keyboard.press('f');await page.wait_for_timeout(300)
                await page.wait_for_function('expected=>TX.flame.heavyWindow().every((x,i)=>Math.abs(x-expected[i])<1e-9)',arg=original,timeout=5000)
                # The standard minimap chooses a window and double-click restores all.
                mini=await page.locator('#overview-canvas').bounding_box()
                x,y,w=mini['x'],mini['y']+20,mini['width']
                await page.mouse.move(x+w*.2,y);await page.mouse.down();await page.mouse.move(x+w*.6,y,steps=8);await page.mouse.up()
                cropped=await page.evaluate('TX.flame.heavyWindow()')
                assert abs(cropped[0]-.2)<.01 and abs(cropped[1]-.6)<.01,(mode,cropped)
                await page.mouse.dblclick(x+w*.4,y);await page.wait_for_timeout(300)
                await page.wait_for_function('expected=>TX.flame.heavyWindow().every((x,i)=>Math.abs(x-expected[i])<1e-9)',arg=original,timeout=5000)
                # Ctrl+wheel and pointer pan use exactly the same chart handlers.
                pt=await bar_point(page,target)
                await page.mouse.move(*pt);await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await page.wait_for_timeout(100)
                zoomed=await page.evaluate('TX.flame.heavyWindow()')
                assert zoomed[1]-zoomed[0]<original[1]-original[0]
                await page.mouse.down();await page.mouse.move(pt[0]+50,pt[1],steps=5);await page.mouse.up()
                assert await page.evaluate('TX.flame.heavyWindow()[0]')<zoomed[0]
                await page.keyboard.press('f');await page.wait_for_timeout(300)
                # A query selection filters all three graphs consistently.
                total=await page.evaluate('TX.flame.profileModel().total')
                await page.evaluate('TX.select(0)');await page.wait_for_timeout(100)
                assert abs(await page.evaluate('TX.flame.profileModel().total')-total/8)<1e-8
            # Deep rows remain accessible; the old renderer silently capped them.
            await page.evaluate("TX.select(null);TX.spans.pick('Shared');TX.go('profile','callees')")
            await page.wait_for_timeout(150)
            await page.mouse.move(400,400);await page.mouse.wheel(0,10000);await page.wait_for_timeout(100)
            shot=ROOT/'out-review/callees-deep.png';shot.parent.mkdir(parents=True,exist_ok=True)
            await page.screenshot(path=str(shot))
            # Scrolling clamps at the chart bottom: the last row sits 12 px above it.
            box=await page.locator('#flame').bounding_box()
            await page.mouse.move(box['x']+60,box['y']+box['height']-19)
            assert 'Deep 47' in await page.locator('#tip').inner_text()
            assert not errors,errors
            await browser.close()
    print('Shared flamegraph: three tabs, selection, zoom, pan, minimap, query filtering and deep rows passed')


if __name__=='__main__': asyncio.run(main())
