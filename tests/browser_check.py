#!/usr/bin/env python3
"""Opens a generated explorer in headless Chromium, builds violins (opens one, adds from a +, merges two picked, drags
a name onto another, renames one, fills the second tree, sets a what-if in both trees), opens a card, shares them (a
link, and saving into the page as on claude.ai, with a stand-in for claude.ai), goes through every tab and mode, and
fails on any console or page error or a change that did not take.
Needs Playwright for Python and its Chromium; tools/with-browser.sh sets up the environment.

  browser_check.py OUT_DIR [--shots DIR]
"""
import argparse
import asyncio
import os
import shutil
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
# claude.ai as a page saving itself sees it: the artifact can publish files, and the viewer can edit.
STAND_IN = """
window.__published = null;
window.claude = { use: async (name) => name === 'artifact' ? { publish: async (files) => { window.__published = files; return { version: 'v2' }; } }
  : name === 'user' ? { canEdit: async () => true } : null };
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
        page = await opened(browser, url, errors, STAND_IN)
        await page.evaluate('localStorage.clear()')
        await page.reload()
        await page.wait_for_function(READY, timeout=60000)
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
            if (TX.layout.canMerge(ids[a], ids[b]) && !TX.layout.isMerged(ids[b])) return [a, b, ids[a]];
          return null;
        }})()""")
        if pair is None:
            errors.append('no two violins to merge by dragging')
        else:
            a, b, moved = pair
            x0, y0 = await centre(page, f'[data-col="{a}"]')
            x1, y1 = await centre(page, f'[data-col="{b}"]')
            await page.mouse.move(x0, y0)
            await page.mouse.down()
            await page.mouse.move(x1, y1, steps=12)
            expect(await page.is_visible('.lift-ghost'), 'a carried name showed nothing by the pointer')
            await shot(page, 'phases-carry')
            await page.mouse.up()
            await page.wait_for_timeout(400)
            expect(await page.evaluate(f'TX.layout.isMerged(TX.layout.parentOf({moved!r}))'), 'dropping a name on a violin merged nothing')
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
        x1, y1 = await centre(page, f'[data-col="{await page.evaluate(f"TX.violins.G.p.cols.findIndex((c) => c.id === {TWO!r})")}"]')
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

        # The card of a merged violin: the units that spend most in it, its members; taking one out keeps the rest.
        merged = await page.evaluate('TX.violins.G.p.cols.findIndex((c) => c.merged && !c.second)')
        if merged < 0:
            errors.append('no merged violin to open a card for')
        else:
            await page.click(f'[data-col="{merged}"]')
            await page.wait_for_timeout(500)
            expect(await page.is_visible('#card-pop .top-unit'), 'the card lists no units')
            members = await page.query_selector_all('#card-pop [data-leave]')
            expect(len(members) >= 2, 'the card of a merged violin lists no members')
            await shot(page, 'card')
            await page.click('#card-pop .top-unit')
            await page.wait_for_timeout(200)
            expect(await page.evaluate('TX.S.sel !== null'), 'clicking a unit in the card selected nothing')
            await page.keyboard.press('Escape')
            await page.keyboard.press('Escape')

        # Save for everyone, as on claude.ai; another viewer opening the page starts with what was saved.
        layout = await page.evaluate(COLS)
        await page.click('#layout-btn')
        await shot(page, 'layout-menu')
        await page.click('#layout-menu [data-do="save"]')
        await page.wait_for_timeout(300)
        published = await page.evaluate('window.__published && window.__published["data/layout.js"]')
        if not published or not published['content'].startswith('window.EXPLORER_LAYOUT = '):
            errors.append('saving for everyone published no layout')
        else:
            with tempfile.TemporaryDirectory() as tmp:
                copy = os.path.join(tmp, 'out')
                shutil.copytree(args.out, copy)
                with open(os.path.join(copy, 'data', 'layout.js'), 'w') as f:
                    f.write(published['content'])
                other = await (await browser.new_context(viewport={'width': 1440, 'height': 820})).new_page()
                other.on('pageerror', lambda e: errors.append(f'page: {e}'))
                await other.goto('file://' + os.path.join(copy, 'index.html'))
                await other.wait_for_function(READY, timeout=60000)
                expect(await other.evaluate(COLS) == layout, 'a viewer of the saved page did not start with its violins')
                await other.close()

        # A link carries the violins: opened where nothing is kept, it shows them.
        link = await page.evaluate('TX.layout.link()')
        fresh = await (await browser.new_context(viewport={'width': 1440, 'height': 820})).new_page()
        fresh.on('pageerror', lambda e: errors.append(f'page: {e}'))
        await fresh.goto(link)
        await fresh.wait_for_function(READY, timeout=60000)
        expect(await fresh.evaluate(COLS) == layout, 'the link did not open the same violins')
        expect('#' not in fresh.url, 'the link stayed in the address after opening')
        print(f'link: {len(link) - len(url)} characters after the address', file=sys.stderr)
        await fresh.close()

        for name, js in STEPS:
            await page.evaluate(js)
            await page.wait_for_timeout(400)
            await shot(page, name)
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
    print(f'{len(STEPS) + 16} steps, {len(errors)} errors')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
