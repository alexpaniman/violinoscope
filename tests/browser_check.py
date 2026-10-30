#!/usr/bin/env python3
"""Exercise tree editing, real dragging, history, portable reports and every view."""
import argparse
import asyncio
import os
import sys
import tempfile

from playwright.async_api import async_playwright

ARGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
STEPS = [
    ('phases', "TX.go('violins')"),
    ('phases-time', "document.querySelector('[data-mode=ms]').click()"),
    ('timeline-chart', "TX.go('timeline', 'chart')"),
    ('timeline-waterfall', "TX.go('timeline', 'waterfall')"),
    ('spans-table', "TX.go('profile', 'table')"),
    ('spans-tree', "document.querySelector('[data-tree=true]').click()"),
    ('spans-flame', "TX.go('profile', 'flame')"),
]
READY = 'window.TX && TX.layout.ready && TX.violins.G'
TWO = '~two'
COLS = 'TX.violins.G.p.cols.map((c) => c.id)'
# claude.ai as a page offering a file sees it: the viewer accepts.
STAND_IN = """
window.__saved = null;
window.claude = { use: async (name) => name === 'downloads' ? { save: async (r) => { window.__saved = { filename: r.filename, size: r.data.size }; return { status: 'saved' }; } } : null };
"""


async def opened(browser, url, errors, init=None):
    page = await browser.new_page(viewport={'width': 1440, 'height': 820}, device_scale_factor=1.5)
    page.on('console', lambda m: errors.append(f'console: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'page: {e}'))
    if init:
        await page.add_init_script(init)
    await page.goto(url)
    await page.wait_for_function(READY, timeout=60000)
    await page.evaluate('TX.checkLayout = true; TX.layout.check()')
    return page


async def centre(page, selector):
    box = await (await page.query_selector(selector)).bounding_box()
    return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2


async def main():
    from pathlib import Path
    ap=argparse.ArgumentParser(description='Tree edits, drag, history and view regression checks')
    ap.add_argument('out');ap.add_argument('--shots');args=ap.parse_args()
    errors=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(args=ARGS)
        page=await opened(browser,(Path(args.out).resolve()/'index.html').as_uri(),errors)
        await page.emulate_media(color_scheme='dark')
        await page.evaluate('TX.layout.fresh()')
        assert await page.locator('[data-add]').count()==2
        await page.locator('[data-add]').first.click()
        await page.locator('#v-add [data-id]').nth(0).check()
        await page.locator('#v-add [data-id]').nth(1).check()
        await page.click('#v-add [data-do="add"]')
        await page.wait_for_timeout(100)
        # Dragging onto a sibling creates a group; undo restores precisely the old tree.
        before=await page.evaluate('JSON.stringify(TX.layout.state())')
        a=await centre(page,'[data-col="1"]');b=await centre(page,'[data-col="2"]')
        await page.mouse.move(*a);await page.mouse.down();await page.mouse.move(*b,steps=12);await page.mouse.up()
        await page.wait_for_timeout(100)
        assert await page.evaluate('TX.layout.state().main.children.some(n=>n.group!==undefined)')
        after=await page.evaluate('JSON.stringify(TX.layout.state())')
        await page.keyboard.press('Control+z');assert await page.evaluate('JSON.stringify(TX.layout.state())')==before
        await page.keyboard.press('Control+Shift+z');assert await page.evaluate('JSON.stringify(TX.layout.state())')==after
        group=await page.evaluate('TX.layout.state().main.children[0].id')
        await page.evaluate('(id)=>TX.openCard(id,{left:100,top:100,right:100,bottom:100})',group)
        assert await page.locator('[data-reveal-part]').count()==2
        heading=await page.locator('.made .section-title').bounding_box()
        label=await page.locator('#card-pop .totals .k').bounding_box()
        assert abs(heading['x']-label['x'])<2
        await page.click('[data-act="move"]');await page.fill('[data-move-find]','Projections');await page.click('[data-move-apply]')
        assert await page.evaluate('(id)=>TX.layout.treeOf(id)===2',group)
        await page.evaluate('TX.panel.closeCard()')
        # Hiding an intermediate group preserves numbers and exposes an unhide connection.
        before_ms=await page.evaluate('(id)=>Array.from(TX.layout.msOf(id))',group)
        await page.evaluate('(id)=>TX.layout.hide(id)',group)
        assert await page.evaluate('(id)=>Array.from(TX.layout.msOf(id))',group)==before_ms
        await page.locator('[data-unhide]').first.click()
        await page.locator('#v-add [data-id]').first.check();await page.click('#v-add [data-do="add"]')
        assert await page.evaluate('(id)=>TX.layout.shown(id)',group)
        # A separate source exposes Rest through Hidden, with no editable recipe or exclusions.
        source=await page.evaluate('''()=>{const T=TX.layout,n=T.configuredChildren(T.state().projections[0].id)[0];T.expand(n);return n;}''')
        await page.evaluate('(id)=>TX.edit.openAdd(id,{left:100,top:300,right:100,bottom:300},"hidden")',source)
        assert await page.locator('#v-add [data-id^="~rest:"]').count()==1
        await page.locator('#v-add [data-id^="~rest:"]').check();await page.click('#v-add [data-do="add"]')
        await page.evaluate('TX.layout.check()')
        # The downloaded report retains hidden state and projection subtrees, offline.
        state=await page.evaluate('JSON.stringify(TX.layout.state())')
        with tempfile.TemporaryDirectory() as tmp:
            async with page.expect_download() as event: await page.click('#download')
            download=await event.value;file=Path(tmp)/'report.html';await download.save_as(file)
            restored=await opened(browser,file.as_uri(),errors)
            assert await restored.evaluate('JSON.stringify(TX.layout.state())')==state
            await restored.close()
        # Every major view renders, including automatic parts before any user expansion.
        for name,code in STEPS:
            await page.evaluate(code);await page.wait_for_timeout(100)
            if args.shots:
                Path(args.shots).mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(Path(args.shots)/(name+'.png')))
        await page.evaluate("TX.go('timeline','waterfall');TX.select(null);TX.nav.fitAll()")
        await page.click('#timeline [data-level="all"]')
        height=await page.locator('.tl-rows').evaluate('(el)=>el.scrollHeight')
        await page.evaluate('TX.select(TX.nav.model().units.at(-1))');await page.wait_for_timeout(200)
        assert await page.locator('.tl-rows').evaluate('(el)=>el.scrollHeight')==height
        assert await page.locator('#timeline').evaluate('(el)=>el.scrollTop')>0
        await page.evaluate('TX.nav.set(...TX.nav.win().map((x,i)=>x+(i?-1:1)*.01))')
        assert await page.locator('.tl-rows').evaluate('(el)=>el.scrollHeight')==height
        await page.evaluate("TX.select(null);TX.go('profile','table')")
        await page.fill('[data-find]','no-such-span');assert await page.locator('.spans-table tbody tr[data-name]').count()==0
        await page.press('[data-find]','Escape');assert await page.locator('.spans-table tbody tr[data-name]').count()>0
        await page.evaluate("TX.go('violins');TX.layout.fresh()")
        await page.click('#layouts');await page.click('[data-layout-clear]')
        assert await page.evaluate('TX.layout.state().main.children.length')==0
        assert not errors,errors
        await browser.close()
    print('Tree menus, drag grouping, undo/redo, movement, hiding, Rest, Made of, offline export and all views passed')

if __name__=='__main__':
    asyncio.run(main())
