#!/usr/bin/env python3
"""The explicit input editor must preview without mutation and preserve undo."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS,opened


async def main():
    errors=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(args=ARGS)
        page=await opened(browser,(Path('out-synthetic/index.html').resolve()).as_uri(),errors)
        model=await page.evaluate("""() => {
          const T=TX.layout;T.fresh();
          const ids=TX.data.columns.filter(c=>!c.second&&!c.async).map(c=>c.id);
          const a=ids.find(id=>T.spansFor(id,'','exclude').length),b=ids.find(id=>T.canMerge(a,id));
          if(!a||!b)throw Error('Fixture requires two phases and a nested span');
          T.exclude(a,[T.spansFor(a,'','exclude')[0].id]);const g=T.merge([a,b],'Preview');
          TX.openCard(g,{left:100,right:100,top:100,bottom:100});return {a,g,state:JSON.stringify(T.state()),time:T.msOf(g)[0]};
        }""")
        await page.click('[data-made]')
        assert await page.locator('[data-input-type="violin"]').count()==2
        await page.locator('[data-replace-input="0"]').click()
        await page.evaluate("id=>[...document.querySelectorAll('#v-add input[data-id]')].find(el=>el.dataset.id===id).click()",model['a'])
        assert '→' in await page.locator('#v-add .add-count').inner_text()
        assert await page.evaluate('JSON.stringify(TX.layout.state())')==model['state']
        await page.click('[data-do="replace"]')
        assert await page.locator('[data-input-type="span"]').count()==1
        assert await page.locator('[data-input-type="span"] [data-reveal-part]').count()==0
        assert await page.evaluate('(g)=>TX.layout.inputs(g)[0].span',model['g'])==model['a']
        await page.keyboard.press('Control+z')
        assert await page.evaluate('JSON.stringify(TX.layout.state())')==model['state']
        await page.keyboard.press('Control+Shift+z')
        assert await page.evaluate('(g)=>TX.layout.inputs(g)[0].span',model['g'])==model['a']
        # Source-dependent Rest rows disappear on a reference replacement and return with undo.
        await page.evaluate("g=>{const T=TX.layout;T.add(T.restsOf(g),g);}",model['g'])
        before=await page.evaluate('JSON.stringify(TX.layout.state())')
        await page.evaluate("({g,a})=>TX.layout.replaceInput(g,0,{violin:a})",model)
        assert await page.evaluate('(g)=>TX.layout.restsOf(g).length',model['g'])==0
        await page.evaluate('TX.layout.undo()')
        assert await page.evaluate('JSON.stringify(TX.layout.state())')==before
        await browser.close()
    assert not errors,errors
    print('Typed input picker, non-mutating preview, source rows, Rest and exact undo passed')


asyncio.run(main())
