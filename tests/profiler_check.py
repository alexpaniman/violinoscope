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
                            '-o',str(folder/f'{name}.html')],check=True,capture_output=True)
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
            await page.close()
            page = await opened('perf')
            assert await page.evaluate('TX.meta.sampled_cpu')
            assert await page.evaluate('TX.data.units[0].ms')==3
            assert await page.locator('[data-tab="timeline"]').is_disabled()
            await page.evaluate("TX.go('timeline')")
            assert await page.evaluate('TX.S.tab')=='profile'
            assert await page.evaluate('TX.flame.profileModel().total')==3
            await page.evaluate("TX.go('profile','table')")
            assert 'Segments' in await page.locator('#spans').inner_text()
            assert not errors,errors
            await browser.close()
    print('Offline Chrome/perf: distinct units, CPU periods, profiles and timeline restrictions passed')


if __name__=='__main__': asyncio.run(main())
