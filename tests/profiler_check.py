#!/usr/bin/env python3
"""Chrome and perf input retain their distinct timing semantics in an offline page."""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from playwright.async_api import async_playwright
from browser_check import ARGS, READY

ROOT = Path(__file__).resolve().parents[1]


async def main():
    errors = []
    with tempfile.TemporaryDirectory(prefix='violinoscope-profiler-') as folder:
        folder = Path(folder)
        for i in range(2):
            (folder/f'unit-{i}.json').write_text(json.dumps({'beginningOfTime':1700000000000000+i*10000,'traceEvents':[
                {'ph':'X','name':'ExecuteCompiler','ts':0,'dur':1000,'pid':1,'tid':1},
                {'ph':'X','name':'Frontend','ts':0,'dur':800,'pid':1,'tid':1},
                {'ph':'X','name':'Total Frontend','ts':0,'dur':800,'pid':1,'tid':2,'args':{'count':1}},
            ]}))
        (folder/'cpu.perf.txt').write_text('''compiler 10/10 1.000000: 1000000 cpu-clock:u:
    aa leaf (/compiler)
    bb main (/compiler)

compiler 10/10 2.000000: 2000000 cpu-clock:u:
    cc other (/compiler)
    bb main (/compiler)
''')
        for name,pattern in [('chrome','unit-*.json'),('perf','cpu.perf.txt')]:
            subprocess.run([sys.executable,str(ROOT/'violinoscope.py'),f'{name}={folder/pattern}',
                            '--timeline','unit','-o',str(folder/f'{name}.html')],check=True,capture_output=True)
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=ARGS)
            context = await browser.new_context(offline=True,viewport={'width':1440,'height':820})
            async def opened(name):
                page = await context.new_page()
                page.on('pageerror',lambda e:errors.append(str(e)))
                await page.goto((folder/f'{name}.html').as_uri())
                await page.wait_for_function(READY)
                return page
            page = await opened('chrome')
            assert await page.evaluate('TX.data.units.length')==2
            assert await page.evaluate('TX.data.units.map(u=>u.l)')==['unit-0','unit-1']
            assert await page.evaluate("TX.spans.focusTree('Frontend').callees.dur")==1.6
            assert await page.evaluate('TX.S.timeline')=='unit'
            assert await page.evaluate('TX.nav.model().dMax')==2
            await page.evaluate("TX.go('timeline');TX.nav.arrange('wall')")
            assert await page.evaluate('TX.nav.model().dMax')==11
            async with page.expect_download() as pending:
                await page.click('#download')
            await (await pending.value).save_as(folder/'saved.html')
            restored = await opened('saved')
            assert await restored.evaluate('TX.S.timeline')=='wall'
            await restored.close()
            await page.close()
            page = await opened('perf')
            assert await page.evaluate('TX.meta.sampled_cpu')
            assert await page.evaluate('TX.data.units[0].ms')==3
            assert await page.locator('[data-tab="timeline"]').inner_text()=='Samples'
            await page.click('[data-tab="timeline"]')
            assert await page.evaluate('TX.S.tab')=='timeline'
            assert await page.locator('#timeline-order').is_hidden()
            assert await page.evaluate('TX.S.flame')=='time'
            assert await page.evaluate('TX.nav.model().dMax-TX.nav.model().dMin')==3
            assert await page.evaluate('TX.nav.model().gaps.length')==0
            await page.evaluate("TX.go('timeline','waterfall')")
            await page.wait_for_function('document.querySelectorAll(".tl-row").length>0')
            assert await page.locator('.tl-critical-toggle').is_hidden()
            await page.evaluate("TX.go('profile','flame')")
            assert await page.evaluate('TX.flame.profileModel().total')==3
            await page.evaluate("TX.go('profile','table')")
            assert 'Segments' in await page.locator('#spans').inner_text()
            # Numeric cells stay inside their columns, including a selected unit and a narrow viewport.
            for width in (1440, 850, 600):
                await page.set_viewport_size({'width':width,'height':820})
                await page.evaluate('TX.select(0);TX.render()')
                await page.wait_for_timeout(80)
                assert await page.evaluate('''()=>[...document.querySelectorAll('.spans-table td.num')].every(cell=>{
                  const box=cell.getBoundingClientRect(), range=document.createRange();range.selectNodeContents(cell);
                  const text=range.getBoundingClientRect();return text.left>=box.left+3&&text.right<=box.right-3;
                })'''), width
                assert await page.evaluate('''()=>[...document.querySelectorAll('.spans-table td.time')].every(cell=>{
                  const value=cell.querySelector('.v').getBoundingClientRect(),bar=cell.querySelector('.meter').getBoundingClientRect();
                  return bar.left-value.right>=7;
                })'''), width
            assert not errors,errors
            await browser.close()
    print('Offline Chrome/perf: units, CPU periods, sample order, profiles and waterfall passed')


if __name__=='__main__': asyncio.run(main())
