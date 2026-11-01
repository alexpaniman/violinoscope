#!/usr/bin/env python3
"""Verify the automatic duration breakdown, its explanations, and exact what-if accounting."""
import argparse
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, opened


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('out')
    ap.add_argument('--shots')
    args = ap.parse_args()
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=ARGS)
        page = await opened(browser, (Path(args.out).resolve() / 'index.html').as_uri(), errors)
        before = await page.evaluate('JSON.stringify(TX.layout.state())')
        await page.evaluate('''() => {
          const f=TX.coarsenParts; TX.coarsenParts=(...args)=>{window.partsProbe={args,parts:f(...args)};return partsProbe.parts};
        }''')
        await page.click('#range-chip')
        assert before == await page.evaluate('JSON.stringify(TX.layout.state())')
        labels = await page.locator('.band-label').all_text_contents()
        assert labels and not any(label.startswith('Rest of ') for label in labels)
        measured = await page.evaluate('''() => {
          const d=TX.layout.breakdown(), {parts,args:[mean]}=partsProbe;
          const ks=parts.flatMap(p=>p.ks),cboNode=d.nodes.findIndex(n=>n.label==='RBO stage: Invoke CBO'),cbo=cboNode>=0;
          const underCbo=k=>{for(;k>=0;k=d.nodes[k].parent)if(k===cboNode)return true;return false;};
          window.cboPart=parts.findIndex(p=>!p.other&&underCbo(p.node));
          return {nodes:d.nodes.length,unique:new Set(ks).size,count:ks.length,
            maxError:Math.max(...d.rows.map(row=>Math.abs(Array.from(row.values()).reduce((a,b)=>a+b,0)-1))),
            cbo,cboShown:window.cboPart>=0,
            bandError:Math.max(...Array.from({length:mean.length},(_,j)=>Math.abs(parts.reduce((a,p)=>a+mean.values(p.ks)[j],0)-1)))};
        }''')
        assert measured['nodes'] == measured['unique'] == measured['count']
        assert measured['maxError'] < 1e-8 and measured['bandError'] < 1e-8
        if measured['cbo']:
            assert measured['cboShown'], 'CBO remains hidden by its parent'
            cbo=await page.evaluate('window.cboPart')
            await page.locator(f'.band-label[data-k="{cbo}"]').hover()
            assert await page.locator('#tip').is_visible()
            label=await page.evaluate('TX.layout.breakdown().nodes[partsProbe.parts[window.cboPart].node].label')
            assert label in await page.locator('#tip').inner_text()
            if args.shots:
                Path(args.shots).mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=f'{args.shots}/cbo.png')
        other = page.locator('.band-label').filter(has_text='Other').last
        await other.hover()
        assert await page.locator('#tip').is_visible()
        tip = await page.locator('#tip').inner_text()
        assert f"of {await page.evaluate('TX.UNIT')}" in tip and ('spans' in tip or 'compilations' in tip or 'No units' in tip)
        await other.click()
        assert await page.locator('#range-details').count() == 0
        assert await page.locator('.range-help').count() == 0
        box = await page.locator('#range-svg').bounding_box()
        await page.mouse.move(box['x'] + box['width'] - 2, box['y'] + 5)
        assert await page.locator('#range-svg').evaluate("e=>getComputedStyle(e).cursor") == 'default'
        assert await page.locator('#card-cross').is_hidden()
        # Display changes do not alter the automatic selection or measurements.
        await page.evaluate('''() => {const c=TX.data.columns.find(c=>!c.second&&TX.layout.open(c.id));if(c)TX.layout.collapse(c.id);}''')
        assert labels == await page.locator('.band-label').all_text_contents()
        # Fresh reports start at the root; configure a phase for factor checks.
        await page.evaluate('''()=>{const L=TX.layout;if(!TX.data.columns.some(c=>!c.second&&!c.async))L.add([L.candidates(L.rootKey())[0].id],L.rootKey());}''')
        # Projected fine-grained shares must sum to the same latency as the existing what-if model.
        for factor in (0, .5, 1.7):
            error = await page.evaluate('''factor => {
              const c=TX.data.columns.find(c=>!c.second&&!c.async);TX.setFactor(c.id,factor);
              const d=TX.layout.breakdown();return Math.max(...d.rows.map((row,i)=>
                Math.abs(Array.from(row.values()).reduce((a,b)=>a+b,0)*TX.data.units[i].ms-TX.totalMs(i,false))));
            }''', factor)
            assert error < .002, error
        # A copied projection intersects the main-tree factor, rather than applying evenly to the parent.
        error = await page.evaluate('''() => {
          const L=TX.layout, c=TX.data.columns.find(c=>!c.second&&!c.async);
          const child=L.kids(c.id).find(id=>!L.async(id))||c.id, copy=L.copyOver(child);
          TX.setFactor(c.id,.5);TX.setFactor(copy,.5);
          const d=L.breakdown();return Math.max(...d.rows.map((row,i)=>
            Math.abs(Array.from(row.values()).reduce((a,b)=>a+b,0)*TX.data.units[i].ms-TX.totalMs(i,false))));
        }''')
        assert error < .002, error
        await browser.close()
    assert not errors, errors
    print(json.dumps({'checks':'automatic parts, conservation, CBO, hover, clean labels, closed branches, what-if',
                      'labels':labels,'nodes':measured['nodes'],'javascript_errors':errors}, indent=2))


asyncio.run(main())
