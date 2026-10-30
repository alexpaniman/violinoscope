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


async def drag_to(page, id, point):
    index = await page.evaluate('(id)=>TX.violins.G.p.cols.findIndex(c=>c.id===id)', id)
    start = await centre(page, f'[data-col="{index}"]')
    await page.mouse.move(*start);await page.mouse.down()
    await page.mouse.move(*point,steps=12);await page.mouse.up()
    await page.wait_for_timeout(100)


async def tree_point(page, id, branch=None):
    return await page.evaluate('''([id,branch])=>{
      const G=TX.violins.G,c=G.p.cols.findIndex(c=>c.id===id),at=TX.violins.nameAt(id),
        box=document.querySelector('#violins').getBoundingClientRect();
      let x=G.xOf(c),y=(G.V.y0+G.V.y1)/2;
      if(branch!==null){
        const parent=G.p.cols.findIndex(c=>c.id===branch || c.root && branch===TX.layout.rootKey());
        x-=G.colW/2;y=G.nodeY(G.depth[parent]);
      }
      return [box.left+at.x+(x-G.xOf(c)-3)*at.z,box.top+at.y+(y-G.TR.y0-G.labelY)*at.z];
    }''', [id, branch])


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
        # Broad column bodies reorder siblings without changing their measurements.
        before=await page.evaluate('JSON.stringify(TX.layout.state())')
        children=await page.evaluate('TX.layout.configuredChildren(TX.layout.rootKey())')
        times=await page.evaluate('(ids)=>ids.map(id=>Array.from(TX.layout.msOf(id)))',children)
        await drag_to(page,children[0],await tree_point(page,children[1]))
        assert await page.evaluate('TX.layout.configuredChildren(TX.layout.rootKey())')==children[::-1]
        assert await page.evaluate('(ids)=>ids.map(id=>Array.from(TX.layout.msOf(id)))',children)==times
        await page.keyboard.press('Control+z');assert await page.evaluate('JSON.stringify(TX.layout.state())')==before
        # Names remain grouping targets; undo restores precisely the old tree.
        a=await centre(page,'[data-col="1"]');b=await centre(page,'[data-col="2"]')
        await page.mouse.move(*a);await page.mouse.down();await page.mouse.move(*b,steps=12);await page.mouse.up()
        await page.wait_for_timeout(100)
        assert await page.evaluate('TX.layout.state().main.children.some(n=>n.group!==undefined)')
        after=await page.evaluate('JSON.stringify(TX.layout.state())')
        await page.keyboard.press('Control+z');assert await page.evaluate('JSON.stringify(TX.layout.state())')==before
        await page.keyboard.press('Control+Shift+z');assert await page.evaluate('JSON.stringify(TX.layout.state())')==after
        group=await page.evaluate('TX.layout.state().main.children[0].id')
        # Opening/closing draws the new points once, with fully opaque SVG layers.
        draws=await page.evaluate('''async(id)=>{
          const proto=WebGLRenderingContext.prototype,original=proto.drawArrays,counts=[];
          let count=0;proto.drawArrays=function(...args){if(this.canvas.id==='v-dots')count++;return original.apply(this,args);};
          try {
            for(const action of ['collapse','expand','collapse','expand']) {
              count=0;TX.layout[action](id);
              for(let i=0;i<4;i++) {
                await new Promise(requestAnimationFrame);
                for(const selector of ['#v-under','#v-over'])
                  if(getComputedStyle(document.querySelector(selector)).opacity!=='1')throw Error('Fading tree layer');
              }
              counts.push(count);
            }
          } finally {proto.drawArrays=original;}
          return counts;
        }''',group)
        assert draws==[1,1,1,1],draws
        # Compact action box: centered eye-off above a plain delete cross.
        await page.mouse.move(*(await tree_point(page,group)))
        hide=await page.locator('#v-actions [data-hide-node]').bounding_box()
        delete=await page.locator('#v-hide').bounding_box()
        actions=await page.locator('#v-actions').bounding_box()
        assert hide['y']+hide['height']==delete['y']
        assert hide['x']==delete['x'] and hide['width']==delete['width']
        assert abs((hide['y']-actions['y'])-(actions['y']+actions['height']-delete['y']-delete['height']))<1
        if args.shots:
            Path(args.shots).mkdir(parents=True,exist_ok=True)
            await page.screenshot(path=str(Path(args.shots)/'tree-controls.png'))
        await page.evaluate('(id)=>TX.openCard(id,{left:100,top:100,right:100,bottom:100})',group)
        assert await page.locator('[data-reveal-part]').count()==2
        heading=await page.locator('.made .section-title').bounding_box()
        label=await page.locator('#card-pop .totals .k').bounding_box()
        assert abs(heading['x']-label['x'])<2
        assert await page.locator('[data-act="move"]').count()==0
        caret=await page.locator('.made-toggle > svg').bounding_box()
        card=await page.locator('#card-pop').bounding_box()
        assert abs((caret['x']-card['x']-1)-(heading['x']-caret['x']-caret['width']))<2
        await page.evaluate('TX.panel.closeCard()')
        # A branch gap chooses both insertion position and level, in both directions.
        members=await page.evaluate('(id)=>TX.layout.configuredChildren(id)',group)
        root=await page.evaluate('TX.layout.rootKey()')
        await drag_to(page,members[0],await tree_point(page,group,root))
        assert await page.evaluate('TX.layout.configuredChildren(TX.layout.rootKey())')==[members[0],group]
        await drag_to(page,members[0],await tree_point(page,members[1],group))
        assert await page.evaluate('(id)=>TX.layout.configuredChildren(id)',group)==members
        assert await page.evaluate('TX.layout.configuredChildren(TX.layout.rootKey())')==[group]
        # The projection + keeps the established copy gesture.
        await drag_to(page,group,await centre(page,'[data-add="~two"]'))
        assert await page.evaluate('(id)=>TX.layout.treeOf(id)===1',group)
        group=await page.evaluate('TX.layout.state().projections.at(-1).id')
        # Hiding an intermediate group preserves numbers and exposes an unhide connection.
        before_ms=await page.evaluate('(id)=>Array.from(TX.layout.msOf(id))',group)
        await page.evaluate('(id)=>TX.layout.hide(id)',group)
        assert await page.evaluate('(id)=>Array.from(TX.layout.msOf(id))',group)==before_ms
        await page.locator('[data-unhide]').first.click()
        assert not await page.locator('#v-add').is_visible()
        assert await page.evaluate('(id)=>TX.layout.shown(id)',group)
        # Multiple hidden ancestors offer only the relevant hidden list, with search.
        outer=await page.evaluate('(id)=>{const T=TX.layout,g=T.merge([id],"Outer group");T.hide(id);T.hide(g);return g;}',group)
        await page.locator('[data-unhide]').first.click()
        assert await page.locator('#v-add [data-mode]').count()==0
        assert await page.locator('#v-add [data-id]').count()==2
        await page.fill('#v-add [data-filter]','Outer group')
        assert await page.locator('#v-add [data-id]').count()==1
        await page.locator('#v-add [data-id]').check();await page.click('#v-add [data-do="add"]')
        assert await page.evaluate('(id)=>TX.layout.shown(id)',outer)
        assert not await page.evaluate('(id)=>TX.layout.shown(id)',group)
        await page.locator('[data-unhide]').first.click()
        assert await page.evaluate('(id)=>TX.layout.shown(id)',group)
        # A separate source exposes Rest through Hidden, with no editable recipe or exclusions.
        source=await page.evaluate('''(group)=>{const T=TX.layout,n=T.configuredChildren(group)[0];T.expand(n);return n;}''',group)
        await page.evaluate('(id)=>TX.edit.openAdd(id,{left:100,top:300,right:100,bottom:300},"hidden")',source)
        assert await page.locator('#v-add [data-mode]').count()==2
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
