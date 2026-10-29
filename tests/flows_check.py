#!/usr/bin/env python3
"""Exercise dependency groups and flow inheritance through conversion and the browser views."""
import asyncio
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright
from browser_check import ARGS, opened
from synth import Trace

ROOT = Path(__file__).resolve().parents[1]


def fixture(folder):
    file = folder / 'flows.jsonl'
    with file.open('w') as out:
        for i in range(12):
            t = Trace(random.Random(i), i)
            base = 1_700_000_000_000_000_000 + i * 150_000_000

            def span(name, parent, start, end, flow=False):
                return t.span(name, parent, base + start * 1_000_000, base + end * 1_000_000,
                              {'span.flow': 'async'} if flow else None)

            root = span('Compile query', '', 0, 100, True)
            phase = span('Annotate IO', root, 0, 60)
            join = span('Await table metadata', phase, 10, 80, True)
            request = span('Resolve', join, 10, 55, True)
            span('Decode', request, 20, 30)
            late = span('Load', join, 30, 130, True)
            span('Await without dependency links', root, 5, 90, True)
            span('Mixed flow', root, 85, 90)
            span('Mixed flow', root, 85, 95, True)
            source = next(s for s in t.spans if s['spanId'] == join)
            source['links'] = [{'traceId': t.trace_id, 'spanId': target,
                                'attributes': [{'key': 'span.link.relation', 'value': {'stringValue': 'depends_on'}}]}
                               for target in (request, late)]
            for s in t.spans:
                out.write(json.dumps(s) + '\n')
    subprocess.run([sys.executable, str(ROOT / 'violinoscope.py'), str(file), '--unit', 'Compile query', '--left', 'flows',
                    '-o', str(folder / 'out')], check=True, capture_output=True)
    return (folder / 'out' / 'index.html').as_uri()


def tail_fixture(folder):
    """A tail covers an apparent 25-second gap and outlasts eleven later roots; another run follows."""
    inputs = []
    for run, count in [('a', 12), ('b', 1)]:
        file = folder / f'{run}.jsonl'
        with file.open('w') as out:
            for i in range(count):
                t = Trace(random.Random(i + (100 if run == 'b' else 0)), i)
                at = 0 if i == 0 else 25000 + (i - 1) * 150
                base = 1_700_000_000_000_000_000 + at * 1_000_000
                root = t.span('Compile query', '', base, base + 100_000_000)
                if i == 0:
                    end = 31500 if run == 'a' else 5000
                    t.span('Long cleanup', root, base + 20_000_000, base + end * 1_000_000, {'span.flow': 'async'})
                for s in t.spans:
                    out.write(json.dumps(s) + '\n')
        inputs.append(f'{run}={file}')
    subprocess.run([sys.executable, str(ROOT / 'violinoscope.py'), *inputs, '--unit', 'Compile query',
                    '--left', 'a,b', '--split-data', '-o', str(folder / 'out')], check=True, capture_output=True)
    return (folder / 'out' / 'index.html').as_uri()


async def delayed_tail(browser, folder, errors):
    """Load a second chunk after navigation has opened, checking both All and an existing zoom."""
    url = tail_fixture(folder)
    data = folder / 'out' / 'data'
    summary = json.loads((data / 'summary.js').read_text().split('=', 1)[1].rstrip().rstrip(';'))
    chunk = json.loads((data / 'trees-0000.js').read_text().split(']=', 1)[1].rstrip().rstrip(';'))
    summary['meta']['chunk'] = 12
    for i, unit in enumerate(summary['units']):
        unit['k'] = i // 12
    (data / 'summary.js').write_text('window.EXPLORER_SUMMARY=' + json.dumps(summary) + ';')
    for k in range(2):
        part = {**chunk, 'chunk': k, 'trees': chunk['trees'][k*12:(k+1)*12]}
        (data / f'trees-{k:04d}.js').write_text(
            f'(window.EXPLORER_CHUNKS=window.EXPLORER_CHUNKS||{{}})[{k}]=' + json.dumps(part) + ';')
    for zoomed in (False, True):
        page = await browser.new_page(viewport={'width': 1440, 'height': 820})
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.add_init_script('''
          const append=Node.prototype.appendChild;
          Node.prototype.appendChild=function(node){
            if(node.tagName==='SCRIPT'&&node.src.endsWith('trees-0001.js')){
              window.releaseTail=()=>append.call(this,node);return node;
            }
            return append.call(this,node);
          };
        ''')
        await page.goto(url)
        await page.wait_for_function('window.releaseTail && TX.chunksLoaded()===1')
        await page.evaluate("TX.go('timeline','chart');TX.nav.win()")
        assert await page.evaluate('TX.nav.model().dMax') == 33100
        if zoomed:
            await page.evaluate('TX.nav.set(33020,33080)')
        await page.evaluate('releaseTail()')
        await page.wait_for_function('TX.layout.ready && TX.chunksLoaded()===TX.chunkCount')
        assert await page.evaluate('TX.nav.model().dMax') == 38000
        window = await page.evaluate('TX.nav.win()')
        if zoomed:
            assert window == [33020,33080], window
        else:
            assert window[0] <= 0 and window[1] >= 38000, window
        await page.close()


async def main():
    errors = []
    with tempfile.TemporaryDirectory(prefix='violinoscope-flows-') as tmp:
        url = fixture(Path(tmp))
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=ARGS)
            page = await opened(browser, url, errors)
            actual = await page.evaluate('''() => {
              const T=TX.layout, root=T.rootKey(), phase=root+'\\x01Annotate IO', join=phase+'\\x01Await table metadata';
              T.add([phase,join]);window.flowTest={phase,join};
              const rows=TX.spansOf(0).rows, request=rows.find(s=>s.name==='Resolve'), child=rows.find(s=>s.name==='Decode');
              return {join:T.msOf(join)[0],copy:T.msOf('\\x02'+join)[0],phase:T.msOf(phase)[0],
                sameFlow:request.flowRoot===child.flowRoot&&request.track===child.track&&request.lane===child.lane,
                childDepth:child.flowDepth,childStartsFlow:child.flowStart,
                bad:T.candidates(TX.ROOT2,'Await without').every(c=>T.independent(c.id)),
                main:TX.data.columns.filter(c=>!c.second).map(c=>c.label)};
            }''')
            assert actual['join'] == 50 and actual['copy'] == 70 and actual['phase'] == 60, actual
            assert actual['sameFlow'] and actual['childDepth'] == 1 and not actual['childStartsFlow'], actual
            assert actual['bad'] and 'Await table metadata' in actual['main'] and 'Resolve' not in actual['main'], actual
            for shown in (True, False, True):
                projection = await page.evaluate('''shown => {
                  const {phase,join}=flowTest,T=TX.layout;if(shown)T.add([join]);else T.hide(join);
                  TX.setFactor(phase,.5);TX.setFactor(join,0);
                  return {total:TX.totalMs(0),fine:T.breakdown().rows[0].reduce((s,v)=>s+v,0)*100};
                }''', shown)
                assert abs(projection['total'] - 70) < 1e-8 and abs(projection['fine'] - 70) < 1e-8, projection
            await page.evaluate('TX.S.factors.clear();TX.setFactor("__none__",1);TX.go("profile","table")')
            for name in ('Resolve', 'Decode'):
                assert await page.locator(f'.spans-table tr[data-name="{name}"] i.async').count() == 1
            mixed = page.locator('.spans-table tr[data-name="Mixed flow"] i.async.mixed')
            assert await mixed.get_attribute('title') == '12 of 24 occurrences in separate logical flows'
            await page.click('[data-tree=true]')
            await page.click('.spans-table [data-level=all]')
            child = page.locator('.spans-table tr[data-name="Decode"]')
            request = page.locator('.spans-table tr[data-name="Resolve"]')
            assert await child.count() == 1, (await page.locator('.spans-table tbody').inner_text(),
                await page.evaluate('({side:TX.S.side,range:TX.S.range,units:TX.allInView(),groups:TX.data.groups})'),errors)
            assert await child.get_attribute('data-path') == (await request.get_attribute('data-path')) + '\x01Decode'
            assert await child.locator('i.async').count() == 1
            # Same-flow child time is deducted from its request's self time, both in aggregate and selection.
            assert await request.locator('td.time').first.get_attribute('title') == '35% of Compile query time'
            await page.evaluate('''() => {
              window.flowLabels=[];const f=CanvasRenderingContext2D.prototype.fillText;
              CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){
                if(text==='Decode'||text==='Resolve')flowLabels.push({text,x,y,canvas:this.canvas.id});
                return f.call(this,text,x,y,...rest);
              };
            }''')
            for view in ('profile', 'timeline'):
                await page.evaluate('''view => {
                  flowLabels=[];TX.S.sel=0;TX.go(view,view==='profile'?'flame':'chart');
                  TX.flame.selectionChanged();if(view==='timeline')TX.flame.zoomToSpan(0,0);
                }''', view)
                await page.wait_for_timeout(600)
                labels = await page.evaluate('flowLabels')
                assert any(c['text'] == 'Decode' for c in labels), (view, labels)
                assert any(c['text'] == 'Decode' and r['text'] == 'Resolve' and c['canvas'] == r['canvas']
                           and c['y'] > r['y'] for c in labels for r in labels), (view, labels)
            await page.evaluate('TX.go("timeline","waterfall")')
            await page.wait_for_timeout(100)
            for name in ('Resolve', 'Decode'):
                row = page.locator('.tl-row').filter(has=page.locator('.nm', has_text=name)).first
                assert await row.locator('.tl-bar.async').count() == 1
                await row.hover()
                expected = 'Starts a separate logical flow' if name == 'Resolve' else 'Within a separate logical flow'
                assert expected in await page.locator('#tip').inner_text()
            # Capture the actual graph inputs, as well as exercising their UI and independent navigation.
            await page.evaluate('''() => {
              window.flowGraphs=[];const f=TX.flameView;
              TX.flameView=(host,tree,bars,opts)=>{flowGraphs.push({inverted:!!opts.inverted,name:tree.name,dur:tree.dur,
                bars:bars.list.map(b=>({name:b.n.name,dur:b.n.dur,width:b.x1-b.x0,async:b.n.async}))});return f(host,tree,bars,opts);};
              TX.spans.pick('Await table metadata');TX.go('profile','callers');
            }''')
            graphs = await page.evaluate('flowGraphs')
            main = [g for g in graphs if not g['inverted'] and g['name'] == 'Await table metadata'][0]
            assert main['dur'] == 840 and len(main['bars']) == 1, main
            flows = {g['name']: g for g in graphs if g['name'] != 'Await table metadata'}
            assert flows['Resolve']['dur'] == 540 and flows['Load']['dur'] == 1200, flows
            assert all(g['bars'][0]['width'] == 1 for g in flows.values()), flows
            decode = next(b for b in flows['Resolve']['bars'] if b['name'] == 'Decode')
            assert abs(decode['width'] - 10/45) < 1e-8 and decode['async'], decode
            assert 'Annotate IO' in await page.locator('.sw-view > .sw-origin').inner_text()
            resolve = page.locator('[data-flow="Resolve"] .sw-canvas')
            load = page.locator('[data-flow="Load"] .sw-canvas')
            await resolve.focus()
            await page.keyboard.press('w')
            assert await resolve.get_attribute('data-window') != '[0,1]'
            assert await load.get_attribute('data-window') == '[0,1]'
            await page.keyboard.press('Escape')
            assert await resolve.get_attribute('data-window') == '[0,1]'
            await page.locator('.sw-origin [data-flow-origin="Annotate IO"]').click()
            assert await page.evaluate('TX.S.name') == 'Annotate IO'
            # A picked ordinary child has same-flow callers, with its creating flow linked separately.
            await page.evaluate("flowGraphs=[];TX.spans.pick('Decode')")
            callers = next(g for g in await page.evaluate('flowGraphs') if g['inverted'])
            assert [b['name'] for b in callers['bars']] == ['Decode', 'Resolve'], callers
            assert 'Await table metadata' in await page.locator('.sw-view > .sw-origin').inner_text()
            with tempfile.TemporaryDirectory(prefix='violinoscope-tails-') as tails:
                tail_page = await opened(browser, tail_fixture(Path(tails)), errors)
                bounds = await tail_page.evaluate('''() => {
                  const n=TX.nav.model();return {end:n.dMax,runs:n.runs.map(r=>[r.d0,r.d1]),gaps:n.gaps.length,win:TX.nav.win()};
                }''')
                assert bounds['end'] == 38000 and bounds['runs'] == [[0,31500],[33000,38000]], bounds
                assert bounds['gaps'] == 0 and bounds['win'][1] > 38000, bounds
                await tail_page.evaluate('''() => {
                  window.tailLabels=[];const f=CanvasRenderingContext2D.prototype.fillText;
                  CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){
                    if(text==='Long cleanup')tailLabels.push({x,y});return f.call(this,text,x,y,...rest);
                  };
                  TX.go('timeline','chart');TX.nav.set(30000,31000);
                }''')
                await tail_page.wait_for_timeout(300)
                # One track header plus a real span bar, even though more than three intervening roots ended.
                assert len(await tail_page.evaluate('tailLabels')) >= 2
                await tail_page.evaluate("TX.go('timeline','waterfall')")
                await tail_page.wait_for_timeout(100)
                assert await tail_page.locator('.tl-row .nm', has_text='Long cleanup').count() == 1
                await tail_page.evaluate('TX.nav.showUnit(12)')
                await tail_page.wait_for_timeout(300)
                window = await tail_page.evaluate('TX.nav.win()')
                assert window[0] <= 33000 and window[1] >= 38000, window
                await tail_page.evaluate('TX.nav.fitAll()')
                await tail_page.wait_for_timeout(300)
                window = await tail_page.evaluate('TX.nav.win()')
                assert window[0] <= 0 and window[1] >= 38000, window
                await tail_page.close()
            with tempfile.TemporaryDirectory(prefix='violinoscope-delayed-') as delayed:
                await delayed_tail(browser, Path(delayed), errors)
            await browser.close()
    assert not errors, errors
    print('Flow checks passed: dependency coverage, inheritance, mixed indicators, waterfall, independent caller/callee flows, long tails, gaps, multiple runs, All and selection')


asyncio.run(main())
