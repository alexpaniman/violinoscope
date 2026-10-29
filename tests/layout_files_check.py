#!/usr/bin/env python3
"""Named layouts, clipboard/file export, missing sources and an offline report."""
import asyncio
import json
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, READY

ROOT = Path(__file__).resolve().parents[1]
CLIPBOARD = """window.__clip='';window.__image=null;
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__clip=text;},readText:async()=>window.__clip,
write:async items=>{window.__image=await items[0].getType('image/png');}}});"""


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=ARGS)
        with tempfile.TemporaryDirectory() as folder:
            copied = Path(folder) / 'report.html'
            copied.write_bytes((ROOT / 'out-synthetic/index.html').read_bytes())
            context = await browser.new_context(offline=True, color_scheme='dark', viewport={'width': 1440, 'height': 900})
            await context.add_init_script(CLIPBOARD)
            page = await context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(copied.as_uri())
            await page.wait_for_function(READY)
            await page.click('#layouts')
            await page.click('[data-layout-new]')
            await page.fill('.layout-name', 'My layout')
            await page.press('.layout-name', 'Enter')
            assert await page.locator('#layouts').get_attribute('title') == 'My layout'
            # Projection definitions and edits autosave into the selected named layout.
            state = await page.evaluate("""() => {
              const T=TX.layout,id=TX.data.columns.find(c=>!c.second).id;T.copyOver(id);T.rename(id,'My phase');return JSON.stringify(T.state());
            }""")
            await page.click('[data-layout-load="0"]')
            assert await page.evaluate('JSON.stringify(TX.layout.state())') != state
            await page.click('[data-layout-load="1"]')
            assert await page.evaluate('JSON.stringify(TX.layout.state())') == state
            await page.reload();await page.wait_for_function(READY)
            assert await page.evaluate('JSON.stringify(TX.layout.state())') == state
            await page.click('#layouts')
            await page.locator('[data-layout-load="1"]').press('F2')
            await page.fill('.layout-name','Renamed');await page.press('.layout-name','Enter')
            await page.locator('[data-layout-load="1"]').press('Alt+ArrowUp')
            assert await page.locator('[data-layout-load="0"]').inner_text() == 'Renamed'
            await page.click('[data-layout-export]')
            await page.wait_for_function("window.__clip.startsWith('{')")
            text = await page.evaluate('__clip')
            doc = json.loads(text)
            assert doc['format'] == 'violinoscope-layout' and doc['version'] == 3
            assert all(isinstance(v,list) for v in doc['paths'])
            assert '\\u0001' not in text and 'next' not in doc
            await page.click('[data-layout-import]')
            assert await page.locator('.layout-row').count() == 3
            # File fallback remains accessible without requiring clipboard permissions.
            async with page.expect_download() as pending:
                await page.click('[data-layout-export]',modifiers=['Shift'])
            download = await pending.value
            file = Path(folder)/'layout.json';await download.save_as(file)
            assert json.loads(file.read_text())['format']=='violinoscope-layout'
            unit=doc['unit'];doc['name']='Missing paths';a,b=len(doc['paths']),len(doc['paths'])+1
            doc['paths'] += [[unit,'Unrecorded A'],[unit,'Unrecorded B']]
            doc.setdefault('groups',[]).append({'id':'g900','name':'Unrecorded pair','inputs':[{'violin':f's{a}'},{'violin':f's{b}'}]})
            doc.setdefault('shown',[]).append('g900')
            await page.evaluate('doc=>TX.layouts.importFile(new File([JSON.stringify(doc)],"missing.json"))',doc)
            assert '2 referenced paths' in await page.locator('.layout-note').inner_text()
            exported=await page.evaluate('TX.layoutFiles.encode(TX.layouts.current())')
            assert next(g for g in exported['groups'] if g['id']=='g900')['name']=='Unrecorded pair'
            await page.click('[data-layout-load="1"]')
            assert not await page.evaluate("TX.layout.candidates(TX.layout.rootKey(),'Unrecorded').length")
            # Invalid input leaves both the working layout and saved library unchanged.
            before=await page.evaluate('JSON.stringify(TX.layout.state())')
            bad={'unit':unit,'name':'Broken','layout':{'v':4,'groups':[['g99','Cycle',[unit+'\x01A']]],'parents':[['g99',unit+'\x01A\x01B']],'shown':['g99']}}
            await page.evaluate('doc=>TX.layouts.importFile(new File([JSON.stringify(doc)],"bad.json"))',bad)
            assert await page.evaluate('JSON.stringify(TX.layout.state())') == before
            assert 'cycle' in await page.locator('#toast').inner_text()
            # Image export includes HTML factor labels and copies a real PNG.
            await page.click('#layouts')
            await page.evaluate("""() => {
              TX.layout.fresh();TX.setFactor(TX.data.columns.find(c=>!c.second&&!c.async).id,.5);
              window.__drawn=[];const original=CanvasRenderingContext2D.prototype.fillText;
              CanvasRenderingContext2D.prototype.fillText=function(text,...args){__drawn.push(String(text));return original.call(this,text,...args);};
            }""")
            factor=await page.locator('#v-factors [data-pill]').first.inner_text()
            await page.evaluate('TX.download.picture()')
            assert await page.evaluate('__image.type') == 'image/png'
            assert await page.evaluate('__image.size') > 1000
            assert factor in await page.evaluate('__drawn')
            colors=await page.evaluate("()=>{const s=getComputedStyle(document.documentElement);return [s.getPropertyValue('--tip-bg').trim(),s.getPropertyValue('--tip-fg').trim()]}")
            assert colors==['#2b3039','#f1f3f6']
            await context.close()
        await browser.close()
    assert not errors,errors
    print('Named layouts, projection persistence, rename/reorder, clipboard/file transfer, missing paths, PNG factors and offline HTML passed')


asyncio.run(main())
