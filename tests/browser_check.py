#!/usr/bin/env python3
"""Opens a generated explorer in headless Chromium, goes through every tab and mode, and fails on any console or
page error. Needs Playwright for Python and its Chromium; tools/with-browser.sh sets up the environment.

  browser_check.py OUT_DIR [--shots DIR]
"""
import argparse
import asyncio
import os
import sys

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


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('--shots', help='directory to save a screenshot of each step to')
    args = ap.parse_args()
    url = 'file://' + os.path.abspath(os.path.join(args.out, 'index.html'))
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=ARGS)
        page = await browser.new_page(viewport={'width': 1440, 'height': 820}, device_scale_factor=1.5)
        page.on('console', lambda m: errors.append(f'console: {m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(f'page: {e}'))
        await page.goto(url)
        await page.wait_for_function('window.TX && window.TX.violins && window.TX.violins.G', timeout=30000)
        for name, js in STEPS:
            await page.evaluate(js)
            await page.wait_for_timeout(400)
            if args.shots:
                await page.screenshot(path=os.path.join(args.shots, f'{name}.png'))
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
            if args.shots:
                await page.screenshot(path=os.path.join(args.shots, 'spans-callers.png'))
        await browser.close()
    for e in errors:
        print(e, file=sys.stderr)
    print(f'{len(STEPS) + 1} steps, {len(errors)} errors')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
