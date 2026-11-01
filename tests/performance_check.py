#!/usr/bin/env python3
"""Measure editing and rendering on a real self-contained report."""
import argparse
import asyncio
import json
import time
import sys
from pathlib import Path
from playwright.async_api import async_playwright
from browser_check import ARGS, centre


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('report')
    ap.add_argument('--output', default='performance.json')
    ap.add_argument('--stress', action='store_true', help='Also add and expand up to 75 distinct names')
    ap.add_argument('--progress', action='store_true', help='Log completed actions while a large report is tested')
    args = ap.parse_args()
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=ARGS)
        page = await browser.new_page(viewport={'width': 1600, 'height': 1050}, color_scheme='dark')
        page.on('pageerror', lambda e: errors.append(str(e)))
        if args.progress:
            page.on('console', lambda m: print(m.text, file=sys.stderr, flush=True) if m.text.startswith('perf:') else None)
        started = time.perf_counter()
        await page.goto(Path(args.report).resolve().as_uri())
        await page.wait_for_function('TX.layout?.version>0', timeout=60000)
        load_ms = (time.perf_counter() - started) * 1000
        if args.progress: print(f'perf: load {load_ms:.1f} ms', file=sys.stderr, flush=True)
        # Let the initial paint and GPU uploads finish before measuring interactions.
        await page.wait_for_timeout(1200)
        timings = await page.evaluate('''async(stress)=>{
          const T=TX.layout,original=T.state(),out={},time=async(name,f)=>{
            const start=performance.now();f();out[name+'Model']=performance.now()-start;
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            out[name]=performance.now()-start;
            console.info('perf: '+name+' '+out[name].toFixed(1)+' ms');
          };
          await time('configuredPicker',()=>T.candidates(T.rootKey()));
          const group=original.main.children.find(n=>n.group!==undefined)?.id;
          if(group)await time('groupPicker',()=>T.candidates(group));
          await time('clear',()=>T.fresh());let rows,projection,child;
          await time('openPicker',()=>{rows=T.candidates(TX.ROOT2,'Compute');if(!rows.length)rows=T.candidates(TX.ROOT2).slice(0,6);});
          await time('addProjection',()=>{projection=T.addGroup(rows.map(r=>r.id),TX.ROOT2,'Properties');});
          await time('collapse',()=>T.collapse(projection));await time('expand',()=>T.expand(projection));
          await time('hide',()=>T.hide(projection));await time('reveal',()=>T.add([projection],TX.ROOT2));
          child=T.configuredChildren(projection)[0];await time('move',()=>T.transfer(child,TX.ROOT2));await time('undo',()=>T.undo());
          await time('rename',()=>T.rename(projection,'Renamed'));T.undo();
          await time('deleteChild',()=>T.remove([child]));T.undo();
          await time('redo',()=>T.redo());T.undo();
          await time('clearChildren',()=>T.clearChildren(projection));T.undo();
          await time('dissolveGroup',()=>T.remove([projection]));T.undo();
          await time('mainPicker',()=>{rows=T.candidates(T.rootKey());});
          await time('addSingle',()=>T.add([rows[0].id],T.rootKey()));
          await time('addEight',()=>T.add(rows.slice(1,9).map(r=>r.id),T.rootKey()));
          const siblings=T.configuredChildren(T.rootKey());
          await time('reorder',()=>T.move(siblings[0],siblings[1],true));
          await time('merge',()=>T.merge(siblings.slice(0,2),'Combined'));
          await time('default',()=>T.load(original));await time('breakdown',()=>T.breakdown());T.check();
          if(stress){
            T.fresh();const names=T.candidates(TX.ROOT2).slice(0,75).map(r=>r.id);let many;
            window.stressNames=names.length;
            await time('add75Names',()=>{many=T.addGroup(names,TX.ROOT2,'Many names');});
            await time('collapse75Names',()=>T.collapse(many));
            await time('expand75Names',()=>T.expand(many));
            await time('delete75Names',()=>{T.collapse(many);T.remove([many]);});T.check();T.load(original);
          }
          await time('flameChart',()=>TX.go('timeline','chart'));
          if(TX.S.view!=='flame'||TX.S.flame!=='time')throw Error('Flame chart did not open');
          for(let k=0;k<6;k++) await time('flamePan'+k,()=>{const [a,b]=TX.nav.win();TX.nav.set(a+(b-a)*.02,b+(b-a)*.02);});
          await time('flameProfile',()=>TX.go('profile','flame'));
          const raw=TX.rawSpans(TX.allInView()[0]),name=raw.names[raw.flat[5] ?? raw.flat[0]];
          TX.spans.pick(name);
          await time('callers',()=>TX.go('profile','callers'));
          await time('callees',()=>TX.go('profile','callees'));
          await time('table',()=>TX.go('profile','table'));
          await time('tableSearch',()=>{TX.S.spansQuery=name;TX.spans.render();});
          await time('tableTree',()=>{TX.S.spansQuery='';TX.S.tableTree=true;TX.spans.render();});
          await time('treeExpandAll',()=>{document.querySelector('#spans [data-level=all]').click();});
          await time('tableScroll',()=>{document.querySelector('#spans').scrollTop=1e8;});
          if(document.querySelectorAll('#spans tr[data-name]').length>100)throw Error('Table rows are not virtualized');
          await time('waterfall',()=>TX.go('timeline','waterfall'));
          if(TX.S.view!=='timeline'||!document.querySelector('.tl-row'))throw Error('Waterfall did not open');
          if(!TX.meta.sampled_cpu){
            await time('criticalPath',()=>document.querySelector('.tl-critical-toggle').click());
          }
          for(let k=0;k<5;k++) await time('waterfallScroll'+k,()=>{document.querySelector('#timeline').scrollTop+=420;});
          TX.go('violins');
          return out;
        }''', args.stress)
        await page.evaluate('''()=>{
          window.dragCosts=[];const move=TX.violins.move;
          TX.violins.move=(...args)=>{const start=performance.now();const result=move(...args);dragCosts.push(performance.now()-start);return result;};
        }''')
        before_drag=await page.evaluate('JSON.stringify(TX.layout.state())')
        if await page.locator('[data-col="1"]').count():
            x, y = await centre(page, '[data-col="1"]')
            await page.mouse.move(x,y);await page.mouse.down()
            await page.mouse.move(x+9,y+8,steps=20);await page.mouse.up()
        if await page.evaluate('JSON.stringify(TX.layout.state())')!=before_drag:
            await page.evaluate('TX.layout.undo()')
        await page.mouse.move(2,2)
        cdp = await page.context.new_cdp_session(page)
        await cdp.send('HeapProfiler.collectGarbage')
        usage = await cdp.send('Runtime.getHeapUsage')
        result = {
            'loadMs': load_ms, 'actionsMs': timings,
            'maxDragHandlerMs': await page.evaluate('Math.max(0,...dragCosts)'),
            'usedHeapBytes': usage['usedSize'],
            'stressNames': await page.evaluate('window.stressNames || 0'),
            'index': await page.evaluate('TX.layout.stats()'),
            'units': await page.evaluate('TX.data.units.length'),
            'columns': await page.evaluate('TX.data.columns.length'),
            'javascriptErrors': errors,
        }
        target = Path(args.output);target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(result,indent=2)+'\n')
        await page.screenshot(path=str(target.with_suffix('.png')))
        assert not errors, errors
        assert result['maxDragHandlerMs'] < 50, result
        assert all(v < 2000 for k,v in timings.items() if not k.endswith('Model')), timings
        await browser.close()
    print(json.dumps(result,indent=2))


if __name__ == '__main__':
    asyncio.run(main())
