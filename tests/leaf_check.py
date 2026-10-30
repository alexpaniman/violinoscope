#!/usr/bin/env python3
"""Leaf controls, zero-valued drops and duplicate membership feedback."""
import asyncio
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS,opened,centre,drag_to
from flame_check import fixture

async def main():
    errors=[]
    with tempfile.TemporaryDirectory(prefix='violinoscope-leaves-') as tmp:
        url=fixture(Path(tmp))
        async with async_playwright() as p:
            browser=await p.chromium.launch(args=ARGS)
            page=await opened(browser,url,errors)
            left,leaf,other=await page.evaluate('''()=>{
              const T=TX.layout,pick=n=>'~pick:'+n;T.fresh();
              const left=T.add([pick('Left')])[0],leaf=T.add([pick('Alpha')],left)[0],other=T.add([pick('Right')])[0];
              return [left,leaf,other];
            }''')
            assert await page.locator(f'[data-open="{left}"]').count()==1
            assert await page.locator(f'[data-open="{leaf}"]').count()==0
            assert await page.locator(f'[data-add="{leaf}"]').count()==0
            # Rest remains accessible without an empty expand arrow.
            await page.evaluate('(id)=>TX.openCard(id,{left:100,top:100,right:100,bottom:100})',leaf)
            await page.click('[data-hidden-items]')
            await page.locator('#v-add [data-id^="~rest:"]').check();await page.click('#v-add [data-do="add"]')
            assert await page.locator(f'[data-open="{leaf}"]').count()==1
            await page.evaluate('(id)=>{TX.panel.closeCard();TX.layout.hide("~rest:"+id);}',leaf)
            assert await page.locator(f'[data-open="{leaf}"]').count()==0
            # No triangle does not prevent a drop into a span leaf.
            before=await page.evaluate('JSON.stringify(TX.layout.state())')
            c=await page.evaluate('(id)=>TX.violins.G.p.cols.findIndex(c=>c.id===id)',leaf)
            await drag_to(page,other,await centre(page,f'[data-col="{c}"]'))
            assert await page.evaluate('(id)=>TX.layout.modelParent(id)',other)==leaf
            assert await page.evaluate('(id)=>Array.from(TX.layout.msOf(id)).every(v=>v===0)',other)
            assert await page.locator(f'[data-open="{leaf}"]').count()==1
            await page.keyboard.press('Control+z')
            assert await page.evaluate('JSON.stringify(TX.layout.state())')==before
            group,member,copy=await page.evaluate('''()=>{
              const T=TX.layout,g=T.addGroup(['~pick:Alpha','~pick:Beta'],TX.ROOT2,'Properties'),member=T.configuredChildren(g)[0];
              return [g,member,T.copyOver(member)];
            }''')
            # Existing members belong in Hidden when hidden; adding never duplicates them.
            assert not await page.evaluate('(g)=>TX.layout.candidates(g,"Alpha").length',group)
            await page.evaluate('(id)=>TX.layout.hide(id)',member)
            await page.evaluate('(g)=>TX.edit.openAdd(g,{left:100,top:300,right:100,bottom:300},"hidden")',group)
            await page.locator(f'#v-add [data-id="{member}"]').check();await page.click('#v-add [data-do="add"]')
            assert await page.evaluate('(id)=>TX.layout.shown(id)',member)
            before=await page.evaluate('JSON.stringify(TX.layout.state())')
            src=await page.evaluate('(id)=>TX.violins.G.p.cols.findIndex(c=>c.id===id)',copy)
            dst=await page.evaluate('(id)=>TX.violins.G.p.cols.findIndex(c=>c.id===id)',group)
            await page.mouse.move(*(await centre(page,f'[data-col="{src}"]')));await page.mouse.down()
            await page.mouse.move(*(await centre(page,f'[data-col="{dst}"]')),steps=12)
            assert 'Already included in Properties' in await page.locator('.lift-ghost').inner_text()
            await page.mouse.up()
            assert await page.evaluate('JSON.stringify(TX.layout.state())')==before
            await page.evaluate('(id)=>TX.layout.remove([id])',member)
            assert await page.evaluate('(g)=>TX.layout.candidates(g,"Alpha").length',group)==1
            assert not errors,errors
            await browser.close()
    print('Leaf arrows, Rest, zero-valued drops, undo and duplicate membership passed')

if __name__=='__main__':asyncio.run(main())
