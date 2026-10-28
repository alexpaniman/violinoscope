#!/usr/bin/env python3
"""Opens a generated explorer in headless Chromium, builds violins (opens one, adds from a +, merges two picked, drags
a name onto another, renames one, fills the second tree, sets a what-if in both trees), opens a card, downloads the
page as one file and opens that (and saves it as on claude.ai, with a stand-in for claude.ai), goes through every tab
and mode, and fails on any console or page error or a change that did not take.
Needs Playwright for Python and its Chromium; tools/with-browser.sh sets up the environment.

  browser_check.py OUT_DIR [--shots DIR]
"""
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
    return page


async def centre(page, selector):
    box = await (await page.query_selector(selector)).bounding_box()
    return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('--shots', help='directory to save a screenshot of each step to')
    args = ap.parse_args()
    url = 'file://' + os.path.abspath(os.path.join(args.out, 'index.html'))
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)
    shot = lambda page, name: page.screenshot(path=os.path.join(args.shots, f'{name}.png')) if args.shots else asyncio.sleep(0)
    errors = []
    expect = lambda ok, what: None if ok else errors.append(what)
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=ARGS)
        page = await opened(browser, url, errors)
        await page.evaluate('localStorage.clear()')
        await page.reload()
        await page.wait_for_function(READY, timeout=60000)
        # From the unit's span and its larger children, whatever the page was saved with.
        await page.evaluate('TX.layout.fresh()')
        await page.wait_for_timeout(300)
        count = lambda: page.evaluate('TX.violins.G.p.cols.length')

        # Open a violin, add what a + offers, then merge two violins picked with Shift.
        n = await count()
        await page.click('[data-open]')
        await page.wait_for_timeout(300)
        expect(await count() > n, 'opening a violin showed nothing more')
        plus = await page.query_selector('[data-add]')
        if plus:
            n = await count()
            await plus.click()
            await page.check('#v-add input[data-id]')
            await page.click('#v-add [data-do="add"]')
            await page.wait_for_timeout(300)
            expect(await count() == n + 1, 'adding from the + list added no violin')
        last = await page.evaluate('TX.violins.G.p.cols.map((c, k) => [c, k]).filter(([c]) => !c.root && !c.second).map(([, k]) => k).slice(-2)')
        n = await count()
        await page.click(f'[data-col="{last[1]}"]', modifiers=['Shift'])
        await page.click(f'[data-col="{last[0]}"]', modifiers=['Shift'])
        await page.click('#v-merge [data-do="merge"]')
        await page.wait_for_timeout(300)
        expect(await count() < n, 'merging two violins left them apart')

        # Hovering a violin shows its × where its line meets its name.
        x, y = await page.evaluate("""(() => {
          const G = TX.violins.G, b = document.getElementById('stage').getBoundingClientRect();
          return [b.left + G.xOf(1), b.top + (G.V.y0 + G.V.y1) / 2];
        })()""")
        await page.mouse.move(x, y)
        await page.wait_for_timeout(100)
        expect(await page.is_visible('#v-hide'), 'hovering a violin showed no ×')

        # Carry one name onto another column it can merge with: they become one, and its name is up for typing.
        pair = await page.evaluate(f"""(() => {{
          const ids = {COLS};
          for (let a = ids.length - 1; a > 0; a--) for (let b = a - 1; b > 0; b--)
            if (TX.layout.canMerge(ids[a], ids[b]) && !TX.layout.isMerged(ids[b])) return [a, b, ids[b]];
          return null;
        }})()""")
        if pair is None:
            errors.append('no two violins to merge by dragging')
        else:
            a, b, target = pair
            x0, y0 = await centre(page, f'[data-col="{a}"]')
            x1, y1 = await centre(page, f'[data-col="{b}"]')
            await page.mouse.move(x0, y0)
            await page.mouse.down()
            await page.mouse.move(x1, y1, steps=12)
            expect(await page.is_visible('.lift-ghost'), 'a carried name showed nothing by the pointer')
            await shot(page, 'phases-carry')
            await page.mouse.up()
            await page.wait_for_timeout(400)
            expect(await page.evaluate(f'TX.layout.isMerged(TX.layout.parentOf({target!r}))'), 'dropping a name on a violin merged nothing')
            name = await page.query_selector('.name-edit')
            if name is None:
                errors.append('a violin merged by dragging was not up for naming')
            else:
                await name.fill('Carried together')
                await name.press('Enter')
                await page.wait_for_timeout(300)
                expect('Carried together' in await page.evaluate('TX.data.columns.map((c) => c.label)'), 'naming the dragged merge did not take')

        # Double-click a name to rename it; any violin can be renamed, and the card still names its spans.
        await page.dblclick('[data-col="1"]')
        await page.wait_for_timeout(200)
        name = await page.query_selector('.name-edit')
        if name is None:
            errors.append('double-clicking a name did not open it for typing')
        else:
            await name.fill('Renamed here')
            await name.press('Enter')
            await page.wait_for_timeout(300)
            expect(await page.evaluate('TX.violins.G.p.cols[1].label') == 'Renamed here', 'renaming a violin did not take')

        # The second tree: spans added from its own +, two of them as one; a name of the first tree carried onto it is
        # copied there. It takes nothing from the first tree's split of each unit's time.
        second = lambda: page.evaluate('TX.data.columns.filter((c) => c.second).length')
        await page.click(f'[data-add="{TWO}"]')
        await page.check('#v-add input[data-id]')
        await page.click('#v-add [data-do="add"]')
        await page.wait_for_timeout(300)
        expect(await second() == 1, 'adding to the second tree added no violin there')
        await page.click(f'[data-add="{TWO}"]')
        boxes = await page.query_selector_all('#v-add input[data-id]')
        for box in boxes[:2]:
            await box.check()
        await page.click('#v-add [data-do="one"]')
        await page.fill('#v-add [data-name]', 'Two as one')
        await page.keyboard.press('Enter')
        await page.wait_for_timeout(300)
        expect('Two as one' in await page.evaluate('TX.data.columns.filter((c) => c.second).map((c) => c.label)'), 'merging in the second tree did not take')
        n = await second()
        x0, y0 = await centre(page, '[data-col="1"]')
        x1, y1 = await centre(page, f'[data-add="{TWO}"]')
        await page.mouse.move(x0, y0)
        await page.mouse.down()
        await page.mouse.move(x1, y1, steps=12)
        await page.mouse.up()
        await page.wait_for_timeout(400)
        expect(await second() == n + 1, 'carrying a name onto the second tree copied nothing')
        expect(await page.evaluate('TX.data.units.every((u) => Math.abs(u.p.reduce((a, b) => a + b, 0) - 1) < 1e-6)'),
               "the second tree changed the first tree's split of unit time")
        # A what-if on a violin of each tree: both apply where they meet, and nothing goes negative or undefined.
        ok = await page.evaluate("""(() => {
          const cols = TX.data.columns, a = cols.findIndex((c) => !c.second), b = cols.findIndex((c) => c.second);
          TX.setFactor(cols[a].id, 0.5); TX.setFactor(cols[b].id, 0);
          const fine = TX.data.units.every((u, i) => { const t = TX.totalMs(i, false); return Number.isFinite(t) && t > 0 && t <= u.ms + 1e-6; });
          const less = TX.data.units.some((u, i) => TX.totalMs(i, false) < u.ms - 1e-6);
          TX.setFactor(cols[a].id, 1); TX.setFactor(cols[b].id, 1);
          return fine && less;
        })()""")
        expect(ok, 'a what-if across both trees gave times that make no sense')
        await shot(page, 'phases-built')

        # The card of a merged violin, opened by a click by its violin, off the dots: its charts and what it is made of,
        # the card itself never scrolling; its name edited in place.
        merged = await page.evaluate('TX.violins.G.p.cols.findIndex((c) => c.merged && !c.second)')
        if merged < 0:
            errors.append('no merged violin to open a card for')
        else:
            x, y = await page.evaluate(f"""(() => {{
              const G = TX.violins.G, b = document.getElementById('stage').getBoundingClientRect();
              return [b.left + G.xOf({merged}), b.top + G.TR.y0 + 2];
            }})()""")
            await page.mouse.click(x, y)
            await page.wait_for_timeout(300)
            expect(await page.is_visible('#card-pop'), 'a click by a violin opened no card')
            expect(len(await page.query_selector_all('#card-pop svg')) >= 1, 'the card shows no chart')
            expect(await page.is_visible('#card-pop .totals'), 'the card shows no time in all')
            expect(await page.evaluate("(() => { const c = document.getElementById('card-pop'); return c.scrollHeight <= c.clientHeight + 1; })()"),
                   'the card scrolls')
            members = await page.query_selector_all('#card-pop [data-leave]')
            expect(len(members) >= 2, 'the card of a merged violin lists no members')
            await shot(page, 'card')
            await page.click('#card-pop [data-rename]')
            await page.fill('#card-pop [data-rename]', 'Named in its card')
            await page.keyboard.press('Enter')
            await page.wait_for_timeout(300)
            expect('Named in its card' in await page.evaluate('TX.data.columns.map((c) => c.label)'), 'renaming in the card did not take')
            await page.keyboard.press('Escape')

        # A violin opened stays open with all its children hidden, its + there to add just the ones wanted.
        stays = await page.evaluate("""(() => {
          const T = TX.layout, c = TX.violins.G.p.cols.find((c) => !c.root && !c.merged && T.kids(c.id).length > 1);
          if (!c) return null;
          T.expand(c.id);
          for (const k of T.kids(c.id)) if (T.shown(k)) T.hide(k);
          return T.open(c.id) && !!document.querySelector(`[data-add="${CSS.escape(c.id)}"]`);
        })()""")
        expect(stays is not False, 'a violin with its children hidden closed, or lost its +')

        # Spans merged inside a merged violin make its child, and stay in it.
        inner = await page.evaluate("""(() => {
          const T = TX.layout, ids = TX.violins.G.p.cols.map((c) => c.id);
          const g = ids.find((id) => T.isMerged(id) && T.members(id).length >= 3);
          if (!g) return null;
          const two = T.members(g).slice(0, 2), id = T.merge(two, 'Inner');
          return T.parentOf(id) === g && two.every((m) => T.members(g).includes(m));
        })()""")
        expect(inner is not False, 'merging inside a merged violin did not make its child')

        # A merged violin under a violin closed waits there, and comes back when it opens again.
        waits = await page.evaluate("""(() => {
          const T = TX.layout, ids = TX.violins.G.p.cols.map((c) => c.id);
          const g = ids.find((id) => T.isMerged(id) && !T.isMerged(T.parentOf(id)) && T.parentOf(id) !== T.rootKey() && !String(T.parentOf(id)).startsWith('~'));
          if (!g) return null;
          const p = T.parentOf(g);
          T.collapse(p);
          const kept = T.isMerged(g) && !T.shown(g);
          T.expand(p);
          return kept && T.shown(g);
        })()""")
        expect(waits is not False, 'a merged violin did not survive closing and opening its parent')

        # A name carried to the edge of a sibling's column moves it there, with what is under it.
        order = await page.evaluate("""(() => {
          const G = TX.violins.G, top = G.p.cols.map((c, k) => [c, k]).filter(([c]) => c.parent === TX.ROOT);
          if (top.length < 2) return null;
          const [a, b] = [top[0][1], top[1][1]], s = document.getElementById('stage').getBoundingClientRect();
          return { a: G.p.cols[a].id, b: G.p.cols[b].id, x: s.left + G.xOf(b) + G.colW * 0.4, y: s.top + G.V.y0 + 20 };
        })()""")
        if order:
            x0, y0 = await centre(page, f'[data-col="{await page.evaluate(f"TX.violins.G.p.cols.findIndex((c) => c.id === {order['a']!r})")}"]')
            await page.mouse.move(x0, y0)
            await page.mouse.down()
            await page.mouse.move(order['x'], order['y'], steps=12)
            await page.mouse.up()
            await page.wait_for_timeout(400)
            ids = await page.evaluate(COLS)
            expect(ids.index(order['b']) < ids.index(order['a']), 'carrying a name past its sibling did not move it')

        # Two violins picked with Shift, removed at once.
        two = await page.evaluate('TX.violins.G.p.cols.map((c, k) => [c, k]).filter(([c]) => !c.root && !c.merged).map(([c, k]) => [c.id, k]).slice(-2)')
        if len(two) == 2:
            for _, k in two:
                await page.click(f'[data-col="{k}"]', modifiers=['Shift'])
            await page.click('#v-merge [data-do="remove"]')
            await page.wait_for_timeout(300)
            ids = await page.evaluate(COLS)
            expect(all(i not in ids for i, _ in two), 'removing two picked violins left them')

        # A merged violin hidden is gone: no longer merged, offered by no + list.
        gone = await page.evaluate("""(() => {
          const c = TX.violins.G.p.cols.find((c) => c.merged && !c.second);
          if (!c) return null;
          TX.layout.hide(c.id);
          return !TX.layout.isMerged(c.id) && !TX.layout.candidates(TX.ROOT, '').some((r) => r.id === c.id);
        })()""")
        expect(gone is not False, 'a hidden merged violin stayed')

        # A + low on the screen: its list, filtered to many rows, stays on screen.
        plus = await page.query_selector_all('[data-add]')
        await plus[-1].click()
        await page.fill('#v-add [data-filter]', 'e')
        await page.wait_for_timeout(200)
        box = await (await page.query_selector('#v-add')).bounding_box()
        expect(box['y'] >= 0 and box['y'] + box['height'] <= 820, f'the + list runs off the screen: {box}')
        await page.keyboard.press('Escape')

        # Download the page as one file; opened where nothing is kept, it shows these violins, and works with no data
        # folder next to it.
        layout = await page.evaluate(COLS)
        async with page.expect_download() as info:
            await page.click('#download')
        with tempfile.TemporaryDirectory() as tmp:
            single = os.path.join(tmp, 'page.html')
            await (await info.value).save_as(single)
            print(f'one file: {os.path.getsize(single) / 1e6:.1f} MB', file=sys.stderr)
            other = await (await browser.new_context(viewport={'width': 1440, 'height': 820})).new_page()
            other.on('pageerror', lambda e: errors.append(f'page (one file): {e}'))
            other.on('console', lambda m: errors.append(f'console (one file): {m.text}') if m.type == 'error' else None)
            await other.goto('file://' + single)
            await other.wait_for_function(READY, timeout=60000)
            expect(await other.evaluate(COLS) == layout, 'the downloaded page did not open with the same violins')
            await shot(other, 'one-file')
            await other.close()
        # On claude.ai the viewer is offered the file.
        await page.evaluate(STAND_IN)
        await page.click('#download')
        await page.wait_for_timeout(500)
        saved = await page.evaluate('window.__saved')
        expect(bool(saved) and saved['filename'].endswith('.html') and saved['size'] > 1000, f'the page offered no file on claude.ai: {saved}')

        for name, js in STEPS:
            await page.evaluate(js)
            await page.wait_for_timeout(400)
            await shot(page, name)
            # In the Timeline, dragging across the strip at the top shows just that stretch.
            if name == 'timeline-waterfall':
                box = await (await page.query_selector('#overview-canvas')).bounding_box()
                before = await page.evaluate('TX.nav.win().slice()')
                y = box['y'] + box['height'] / 2
                await page.mouse.move(box['x'] + box['width'] * 0.3, y)
                await page.mouse.down()
                await page.mouse.move(box['x'] + box['width'] * 0.5, y, steps=8)
                await page.mouse.up()
                await page.wait_for_timeout(500)
                after = await page.evaluate('TX.nav.win().slice()')
                expect(after[1] - after[0] < (before[1] - before[0]) * 0.5, f'dragging across the strip did not narrow the view: {before} -> {after}')
                await shot(page, 'timeline-picked')
                expect(not await page.is_visible('[data-nav="back"]'), 'the Back button is still there')
        # Pick the heaviest span name in the table, then look at its callers and callees.
        await page.evaluate("TX.go('profile', 'table')")
        await page.wait_for_timeout(300)
        row = await page.query_selector('#spans-body tr[data-name]')
        if row is None:
            errors.append('no rows in the spans table')
        else:
            await row.click()
            await page.evaluate("TX.go('profile', 'callers')")
            await page.wait_for_timeout(400)
            await shot(page, 'spans-callers')
        await browser.close()
    for e in errors:
        print(e, file=sys.stderr)
    print(f'{len(STEPS) + 24} steps, {len(errors)} errors')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
