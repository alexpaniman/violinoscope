#!/usr/bin/env python3
"""Named layouts, portable export, missing paths, undo, and an offline report."""
import asyncio
import json
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, READY

ROOT = Path(__file__).resolve().parents[1]


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=ARGS)
        with tempfile.TemporaryDirectory() as folder:
            copied = Path(folder) / 'report.html'
            copied.write_bytes((ROOT / 'out-synthetic/index.html').read_bytes())
            context = await browser.new_context(offline=True, color_scheme='dark', viewport={'width': 1440, 'height': 900})
            page = await context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(copied.as_uri())
            await page.wait_for_function(READY)
            await page.click('#layouts')
            await page.fill('#layout-name', 'My layout')
            await page.click('#layout-save-form button')
            assert await page.locator('#layouts').get_attribute('title') == 'My layout'
            before = await page.evaluate('JSON.stringify(TX.layout.state())')
            await page.evaluate("TX.layout.rename(TX.layout.rootKey(),'Renamed root')")
            assert 'Modified' in await page.locator('#layouts').get_attribute('title')
            await page.click('[data-layout-load="0"]')
            assert await page.evaluate('JSON.stringify(TX.layout.state())') == before
            await page.evaluate('TX.layout.undo()')
            assert await page.evaluate('TX.layout.label(TX.layout.rootKey())') == 'Renamed root'
            await page.click('#layout-save-form button')
            async with page.expect_download() as pending:
                await page.click('[data-layout-export]')
            download = await pending.value
            file = Path(folder) / 'layout.json'
            await download.save_as(file)
            doc = json.loads(file.read_text())
            assert doc['format'] == 'violinoscope-layout' and doc['paths']
            assert all(isinstance(v, list) for v in doc['paths'])
            assert '\\u0001' not in file.read_text() and 'next' not in doc
            unit = doc['unit']
            doc['name'] = 'Missing paths'
            a, b = len(doc['paths']), len(doc['paths']) + 1
            doc['paths'] += [[unit, 'Unrecorded A'], [unit, 'Unrecorded B']]
            doc.setdefault('groups', []).append({'id':'g900','name':'Unrecorded pair','parts':[f's{a}', f's{b}']})
            doc.setdefault('shown', []).append('g900')
            await page.evaluate('doc=>TX.layouts.importFile(new File([JSON.stringify(doc)],"missing.json"))', doc)
            assert '2 referenced paths' in await page.locator('.layout-note').inner_text()
            exported = await page.evaluate('TX.layoutFiles.encode(TX.layouts.current())')
            assert next(g for g in exported['groups'] if g['id']=='g900')['name']=='Unrecorded pair'
            assert [unit,'Unrecorded A'] in exported['paths']
            # Reject an implicit ancestor cycle without changing the working copy.
            before = await page.evaluate('JSON.stringify(TX.layout.state())')
            bad = {'unit':unit,'name':'Broken','layout':{'v':4,'groups':[['g99','Cycle',[unit+'\x01A']]],
                   'parents':[['g99',unit+'\x01A\x01B']], 'shown':['g99']}}
            await page.evaluate('doc=>TX.layouts.importFile(new File([JSON.stringify(doc)],"bad.json"))', bad)
            assert await page.evaluate('JSON.stringify(TX.layout.state())') == before
            assert 'cycle' in await page.locator('#toast').inner_text()
            # Dark hover colors use a readable slate background, independent of light-theme defaults.
            colors = await page.evaluate("()=>{const s=getComputedStyle(document.documentElement);return [s.getPropertyValue('--tip-bg').trim(),s.getPropertyValue('--tip-fg').trim()]}")
            assert colors == ['#2b3039', '#f1f3f6'], colors
            await context.close()
        await browser.close()
    assert not errors, errors
    print('Named layouts, missing paths, undo, offline HTML and dark tooltips passed')


asyncio.run(main())
