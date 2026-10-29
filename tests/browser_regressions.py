#!/usr/bin/env python3
"""Browser checks for composition, transfers, history, parallel work and navigable views."""
import argparse
import asyncio
import json
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, opened, READY


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('out')
    ap.add_argument('--shots')
    args = ap.parse_args()
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=ARGS)
        page = await opened(browser, (Path(args.out).resolve() / 'index.html').as_uri(), errors)
        await page.evaluate('TX.layout.fresh()')
        # A merged definition moves both ways through the destination picker.
        group = await page.evaluate("""() => {
          const T=TX.layout, ids=TX.data.columns.filter(c=>!c.second).map(c=>c.id);
          const pair=ids.flatMap(a=>ids.filter(b=>T.canMerge(a,b)).map(b=>[a,b]))[0];
          if(!pair) throw Error('Fixture needs two mergeable phases');
          const g=T.merge(pair,'Transfer test'); TX.openCard(g,{left:100,top:100,right:100,bottom:100});
          return g;
        }""")
        before = await page.evaluate('JSON.stringify(TX.layout.state())')
        await page.click('#card-pop [data-act="move"]')
        await page.fill('[data-move-find]', 'no such destination')
        assert await page.locator('[data-move-apply]').is_disabled()
        assert await page.locator('#card-pop').is_visible()
        await page.fill('[data-move-find]', 'projec')
        assert await page.locator('[data-move-target]').count() == 1
        await page.keyboard.press('Escape')
        assert await page.locator('#v-move').is_hidden()
        await page.click('#card-pop [data-act="move"]')
        assert 'releases' in await page.inner_text('[data-move-preview]')
        await page.click('[data-move-apply]')
        after = await page.evaluate('JSON.stringify(TX.layout.state())')
        assert before != after
        assert await page.evaluate('(id)=>TX.layout.isMerged(id) && TX.layout.treeOf(id)===2', group)
        await page.keyboard.press('Control+z')
        assert await page.evaluate('JSON.stringify(TX.layout.state())') == before
        await page.keyboard.press('Control+Shift+z')
        assert await page.evaluate('JSON.stringify(TX.layout.state())') == after
        projection = await page.evaluate("TX.data.columns.find(c=>c.second&&c.label==='Transfer test').id")
        await page.evaluate('(id)=>TX.openCard(id,{left:100,top:100,right:100,bottom:100})', projection)
        await page.click('#card-pop [data-act="move"]')
        assert 'transfers' in await page.inner_text('[data-move-preview]')
        if args.shots:
            Path(args.shots).mkdir(parents=True,exist_ok=True)
            await page.screenshot(path=f'{args.shots}/move.png')
        await page.click('[data-move-apply]')
        assert await page.evaluate("TX.data.columns.some(c=>!c.second&&c.label==='Transfer test')")
        # A hidden custom operand survives and can be revealed from Made of.
        outer = await page.evaluate("""() => {
          const T=TX.layout; T.fresh();
          const ids=T.candidates(T.rootKey(),'').map(c=>c.id).filter(id=>!T.async(id));
          let triple; find: for(const a of ids) for(const b of ids) if(T.canMerge(a,b)) for(const c of ids) if(T.canMerge(a,c)&&T.canMerge(b,c)){triple=[a,b,c];break find;}
          if(!triple)throw Error('Fixture needs three independent paths');
          T.add(triple); const inner=T.merge(triple.slice(0,2),'Inner retained');
          const g=T.merge([inner,triple[2]],'Outer retained'); T.hide(inner);
          TX.openCard(g,{left:100,top:100,right:100,bottom:100});return {g,inner};
        }""")
        if await page.get_attribute('[data-made]', 'aria-expanded') != 'true':
            await page.click('[data-made]')
        assert await page.locator('[data-reveal-part]').count() == 2
        await page.locator('[data-reveal-part]').filter(has_text='Inner retained').click()
        assert await page.evaluate('(id)=>TX.layout.shown(id)', outer['inner'])
        await page.evaluate('TX.panel.closeCard()')
        # Download and reload exactly this nested composition.
        state = await page.evaluate('JSON.stringify(TX.layout.state())')
        with tempfile.TemporaryDirectory() as tmp:
            async with page.expect_download() as event:
                await page.click('#download')
            download = await event.value
            file = Path(tmp) / 'nested.html'
            await download.save_as(str(file))
            restored = await opened(browser, file.as_uri(), errors)
            assert await restored.evaluate('JSON.stringify(TX.layout.state())') == state
            await restored.close()
        # Async duration must not participate in the main elapsed-time partition or what-if savings.
        parallel = await page.evaluate("""() => {
          const T=TX.layout, a=T.candidates(TX.ROOT2,'').find(c=>T.async(c.id));
          if(!a)return false;
          const before=TX.data.units.map(u=>Array.from(u.p));T.add([a.id],TX.ROOT2);
          const same=TX.data.units.every((u,i)=>u.p.every((v,k)=>Math.abs(v-before[i][k])<1e-9));
          TX.setFactor(a.id,.5);
          const unchanged=TX.data.units.every((u,i)=>Math.abs(TX.totalMs(i,false)-u.ms)<1e-7);
          TX.setFactor(a.id,1);return same&&unchanged;
        }""")
        assert parallel, 'Async spans changed elapsed time or fixture has none'
        # Keep all rows of a touched compilation, including bars completely outside the window.
        await page.evaluate("TX.go('timeline','waterfall'); TX.select(null); TX.nav.fitAll()")
        await page.click('#timeline [data-level="all"]')
        outside_row = await page.evaluate("""() => {
          const n=TX.nav.model(),i=n.units[0],at=n.start[i],ms=TX.data.units[i].ms;
          const row=TX.spansOf(i).rows.findIndex((s,r)=>r>0&&(s.start+s.dur<ms*.45||s.start>ms*.55));
          if(row<0)throw Error('Fixture needs a span outside the zoom window');
          TX.nav.set(at+ms*.45,at+ms*.55,{focus:{unit:i,row}});return row;
        }""")
        await page.wait_for_timeout(400)
        assert await page.locator(f'.tl-row[data-j="{outside_row}"]').count() == 1
        late_row = await page.evaluate("""() => {
          const n=TX.nav.model(),i=n.units[0],at=n.start[i],ms=TX.data.units[i].ms,rs=TX.spansOf(i).rows;
          const row=rs.findIndex((s,r)=>r>0&&(s.flags&1)&&s.start+s.dur>ms);
          if(row<0)return null;
          const end=rs[row].start+rs[row].dur, middle=(ms+end)/2;
          TX.nav.set(at+middle,at+end,{focus:{unit:i,row}});return row;
        }""")
        if late_row is not None:
            await page.wait_for_timeout(400)
            assert await page.locator(f'.tl-row[data-j="{late_row}"]').count() == 1, 'Async tail disappeared after its request ended'
        # Search is adjacent to the span-name column.
        await page.evaluate("TX.go('profile','table')")
        search_box = await page.locator('[data-find]').bounding_box()
        name_box = await page.locator('.spans-table th').first.bounding_box()
        assert abs(search_box['x']-name_box['x']) < 40
        # Both flame graphs have their own viewport, history, overview, keyboard and scroll area.
        await page.evaluate("""() => {
          const rs=TX.spansOf(0).rows;
          const s=rs.find((s,i)=>s.parent>=0&&!(s.flags&1)&&rs.some(c=>c.parent===i));
          if(!s)throw Error('Fixture needs a span with callers and callees');
          TX.spans.pick(s.name);TX.go('profile','callers');
        }""")
        await page.wait_for_timeout(300)
        up = page.locator('[data-which="up"] .sw-canvas')
        down = page.locator('[data-which="down"] .sw-canvas')
        initial = await down.get_attribute('data-window')
        await up.focus()
        await page.keyboard.press('w')
        assert await up.get_attribute('data-window') != '[0,1]'
        assert await down.get_attribute('data-window') == initial
        await page.keyboard.press('Escape')
        assert await up.get_attribute('data-window') == '[0,1]'
        await down.focus()
        await page.keyboard.press('w')
        assert await down.get_attribute('data-window') != initial
        assert await up.get_attribute('data-window') == '[0,1]'
        await page.keyboard.press('Escape')
        box = await down.bounding_box()
        await down.click(position={'x':5,'y':27})
        clicked = await down.get_attribute('data-window')
        assert clicked != initial, 'Clicking a callee did not zoom into its bar'
        await page.mouse.move(box['x']+box['width']/2,box['y']+9)
        await page.mouse.down()
        await page.mouse.move(box['x']+box['width']/2-40,box['y']+9,steps=5)
        await page.mouse.up()
        assert await down.get_attribute('data-window') != clicked, 'Dragging did not pan the callee graph'
        mini = await page.locator('[data-which="down"] .sw-overview').bounding_box()
        await page.mouse.move(mini['x']+mini['width']*.2,mini['y']+10)
        await page.mouse.down()
        await page.mouse.move(mini['x']+mini['width']*.5,mini['y']+10,steps=5)
        await page.mouse.up()
        window = json.loads(await down.get_attribute('data-window'))
        assert .2 < window[1]-window[0] < .4
        assert await up.get_attribute('data-window') == '[0,1]'
        if args.shots:
            await page.wait_for_timeout(2700)
            await page.screenshot(path=f'{args.shots}/callers.png')
        assert await page.locator('.sw-overview').count() == 2
        await page.evaluate('TX.layout.check()')
        await browser.close()
    assert not errors, '\n'.join(errors)
    print('8 browser regression scenarios, 0 errors')


if __name__ == '__main__':
    asyncio.run(main())
