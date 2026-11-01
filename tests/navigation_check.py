#!/usr/bin/env python3
"""Wheel distance, fold anchoring and zoom targets across concurrent compilations."""
import asyncio
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, opened

ROOT = Path(__file__).resolve().parents[1]


def fixture(folder):
    for unit in range(12):
        events = [{'ph':'X','name':'Compile','ts':0,'dur':100000,'pid':unit,'tid':0}]
        for branch in range(30):
            a = branch * 3000
            events.append({'ph':'X','name':f'Branch {branch}','ts':a,'dur':2800,'pid':unit,'tid':0})
            for depth in range(10):
                events.append({'ph':'X','name':f'Depth {depth}','ts':a+depth+1,'dur':2700-depth*2,'pid':unit,'tid':0})
        (folder/f'unit-{unit:02}.json').write_text(json.dumps({'beginningOfTime':1700000000000000,'traceEvents':events}))
    (folder/'long.json').write_text(json.dumps({'beginningOfTime':1700000000200000,'traceEvents':[
        {'ph':'X','name':'Compile','ts':0,'dur':1000000000,'pid':99,'tid':0}]}))
    out = folder/'out'
    subprocess.run([sys.executable,str(ROOT/'violinoscope.py'),f'Build={folder}/*.json','--unit','Compile','-o',str(out)],check=True,capture_output=True)
    # Exercise the browser scroll-height ceiling without millions of fixture rows.
    page = out/'index.html'
    text = page.read_text()
    assert 'MAXH = 8e6' in text
    page.write_text(text.replace('MAXH = 8e6','MAXH = 4096'))
    return page.as_uri()


async def main():
    errors = []
    with tempfile.TemporaryDirectory(prefix='violinoscope-navigation-') as tmp:
        url = fixture(Path(tmp))
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=ARGS)
            page = await opened(browser,url,errors,init='''
              window.chartText=[];
              const fill=CanvasRenderingContext2D.prototype.fillText,clear=CanvasRenderingContext2D.prototype.clearRect;
              CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.id==='flame-canvas')chartText=[];return clear.apply(this,args);};
              CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){if(this.canvas.id==='flame-canvas')chartText.push({text,x,y});return fill.call(this,text,x,y,...args);};
            ''')
            await page.evaluate("TX.go('timeline','waterfall')")
            await page.wait_for_timeout(100)
            top = "document.querySelector('#timeline .tl-head').getBoundingClientRect().bottom"
            anchor = await page.evaluate(f'''()=>{{const y={top};const r=[...document.querySelectorAll('.tl-row')].find(r=>r.getBoundingClientRect().top>=y+150);return {{unit:r.dataset.unit,row:r.dataset.row,y:r.getBoundingClientRect().top}};}}''')
            selector = f'.tl-row[data-unit="{anchor["unit"]}"][data-row="{anchor["row"]}"]'
            await page.evaluate('document.querySelector("#timeline").addEventListener("wheel", e=>window.lastWheel={y:e.deltaY,mode:e.deltaMode})')
            await page.mouse.move(600,500)
            await page.mouse.wheel(0,100)
            await page.wait_for_timeout(100)
            delta = await page.evaluate('lastWheel.y')
            assert abs((await page.locator(selector).bounding_box())['y']-anchor['y']+delta)<1
            await page.locator('#timeline').dispatch_event('wheel',{'deltaY':2,'deltaMode':1,'bubbles':True,'cancelable':True})
            await page.wait_for_timeout(50)
            assert abs((await page.locator(selector).bounding_box())['y']-anchor['y']+delta+52)<1
            # A native scrollbar jump still covers the whole recording.
            await page.locator('#timeline').evaluate('e=>e.scrollTop=700')
            await page.wait_for_timeout(100)
            target = await page.evaluate(f'''()=>{{const y={top};const b=[...document.querySelectorAll('.tl-row button[data-fold]')].find(b=>{{const r=b.getBoundingClientRect();return r.top>y+50&&r.bottom<y+300;}});const r=b.closest('.tl-row');return {{unit:r.dataset.unit,row:r.dataset.row,y:r.getBoundingClientRect().top}};}}''')
            selector = f'.tl-row[data-unit="{target["unit"]}"][data-row="{target["row"]}"]'
            for _ in range(2):
                await page.locator(selector+' button[data-fold]').click()
                await page.wait_for_timeout(100)
                assert abs((await page.locator(selector).bounding_box())['y']-target['y'])<1
            await page.evaluate("TX.go('timeline','chart')")
            await page.wait_for_timeout(100)
            labels = await page.evaluate("chartText.filter(r=>r.text.startsWith('Concurrent lane'))")
            assert len(labels)>=3
            label = labels[2]
            target = await page.evaluate("TX.data.units.findIndex(u=>u.l==='unit-02')")
            await page.evaluate('(i)=>TX.select(i,{keepWindow:true})',target)
            await page.wait_for_timeout(100)
            assert labels==await page.evaluate("chartText.filter(r=>r.text.startsWith('Concurrent lane'))")
            await page.evaluate('TX.select(null,{keepWindow:true})')
            # Two real clicks must zoom to the original tiny bar, without expanding it between clicks.
            point = await page.evaluate('''({i,y})=>{const m=TX.nav.model(),[a,b]=TX.nav.win(),box=document.querySelector('#flame').getBoundingClientRect();return [box.left+Math.floor(16+(m.start[i]-a)/(b-a)*(box.width-36))+.5,box.top+y+11];}''',{'i':target,'y':label['y']})
            await page.mouse.click(*point)
            # A control reflow between native clicks must not change the zoom target.
            await page.evaluate("document.querySelector('#controls').style.paddingBottom='20px';TX.render()")
            await page.wait_for_timeout(30)
            expected_y = await page.evaluate("chartText.find(r=>r.text==='Concurrent lane 3').y+11")
            await page.mouse.down(click_count=2)
            await page.mouse.up(click_count=2)
            await page.wait_for_timeout(350)
            assert await page.evaluate('TX.S.sel')==target
            measured = await page.evaluate('''i=>{const [a,b]=TX.nav.win();return {width:b-a,center:(a+b)/2-TX.nav.model().start[i],labels:chartText.filter(r=>r.text.includes(TX.data.units[i].l))};}''',target)
            assert abs(measured['width']-110)<.001 and abs(measured['center']-50)<.001,measured
            assert measured['labels'] and abs(measured['labels'][0]['y']-expected_y)<1,measured
            # Line-mode wheel events move vertically; they never zoom implicitly.
            before = await page.evaluate("({window:TX.nav.win().slice(),label:chartText.find(r=>r.text==='Concurrent lane 3')})")
            await page.locator('#flame-canvas').dispatch_event('wheel',{'deltaY':3,'deltaMode':1,'bubbles':True,'cancelable':True})
            await page.wait_for_timeout(100)
            assert before['window']==await page.evaluate('TX.nav.win()')
            after = await page.evaluate("chartText.find(r=>r.text==='Concurrent lane 3')")
            assert after is not None and abs(after['y']-before['label']['y']+45)<1,(before,after)
            # Horizontal zoom never changes lane height or the vertical scroll position, even across detail thresholds.
            y = after['y']
            await page.evaluate('TX.nav.fitAll()')
            for _ in range(8):
                await page.wait_for_timeout(40)
                assert abs(await page.evaluate("chartText.find(r=>r.text==='Concurrent lane 3').y")-y)<1
            original = await page.evaluate('JSON.stringify(TX.data.units)')
            await page.evaluate('TX.select(null,{keepWindow:true})')
            await page.click('[data-timeline="unit"]')
            await page.wait_for_timeout(100)
            assert await page.evaluate("chartText.every(r=>!r.text.startsWith('Concurrent lane'))")
            assert await page.evaluate("chartText.some(r=>r.text.includes('Concatenated unit time'))")
            assert await page.evaluate('''()=>{const m=TX.nav.model();return m.units.every((i,k)=>!k||m.start[i]>=m.start[m.units[k-1]]+TX.data.units[m.units[k-1]].ms);}''')
            assert original==await page.evaluate('JSON.stringify(TX.data.units)')
            ticks = await page.evaluate('TX.elapsedTicks(TX.nav.model(),16945490,16945500,1500).map(t=>t.label)')
            assert len(ticks)>5 and len(set(ticks))==len(ticks), ticks
            await page.evaluate('(i)=>TX.flame.zoomToSpan(i,0)',target)
            await page.wait_for_timeout(350)
            assert await page.evaluate('chartText.some(r=>r.text.includes("unit-02"))')
            await page.click('[data-timeline="wall"]')
            await page.wait_for_timeout(100)
            assert await page.evaluate("chartText.some(r=>r.text.startsWith('Concurrent lane'))")
            # A short chart also leaves plain wheel input as scrolling, without switching to zoom.
            await page.evaluate('TX.S.range=[999000,1001000];TX.render()')
            before = await page.evaluate('TX.nav.win().slice()')
            await page.mouse.wheel(0,-100)
            await page.wait_for_timeout(100)
            assert before==await page.evaluate('TX.nav.win()')
            assert not errors,errors
            await browser.close()
    print('Navigation: unscaled wheel, exact fold anchors, stable concurrent lanes, target zoom and line-mode scrolling passed')


if __name__=='__main__': asyncio.run(main())
