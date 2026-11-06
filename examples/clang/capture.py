#!/usr/bin/env python3
"""Capture the README's UI views from a generated Clang report (requires Playwright)."""
import argparse
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright


async def capture(args):
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=[
            '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
        ])
        page = await browser.new_page(viewport={'width': 1680, 'height': 940}, device_scale_factor=1.5)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.emulate_media(color_scheme='dark')
        await page.goto(Path(args.report).resolve().as_uri())
        await page.wait_for_function(
            'window.TX && TX.layout.ready && TX.violins.G && TX.chunksLoaded() === TX.chunkCount',
            timeout=120000,
        )
        await page.evaluate('document.fonts.ready')
        await page.evaluate('TX.checkLayout = true; TX.layout.check()')

        async def shot(name, clip=None):
            await page.mouse.move(1, 1)
            await page.wait_for_timeout(500)  # Finish zoom/selection animations.
            await page.screenshot(path=str(out / f'clang-{name}.png'), clip=clip)

        await shot('phases')
        await page.click('#range-chip')
        card = await page.locator('#rangecard').bounding_box()
        await shot('time', {'x': card['x'] - 64, 'y': 0,
                            'width': 1680 - card['x'] + 64, 'height': card['y'] + card['height'] + 20})
        await page.click('#range-chip')

        unit = await page.evaluate('(name) => TX.data.units.findIndex(u => u.l === name)', args.unit)
        if unit < 0:
            raise ValueError(f'Compilation not found: {args.unit}')
        await page.set_viewport_size({'width': 1200, 'height': 600})
        await page.evaluate("i => { TX.go('timeline', 'waterfall'); TX.select(i); }", unit)
        await page.wait_for_timeout(600)
        await page.click('[data-level=none]')
        for _ in range(2):
            await page.click('[data-level=more]')
        # Keep the front-end calls folded; show the two main back-end stages.
        frontends = page.locator('.tl-row.sel').filter(has=page.locator('.nm', has_text='Frontend')).filter(
            has=page.locator('[data-fold][aria-expanded=true]'))
        while await frontends.count():
            await frontends.first.locator('[data-fold]').click()
        await page.evaluate('TX.timeline.selectionChanged(false)')
        await page.wait_for_timeout(200)
        last = await page.locator('.tl-row.sel').last.bounding_box()
        await shot('waterfall', {'x': 0, 'y': 0, 'width': 1200, 'height': last['y'] + last['height'] + 4})

        await page.set_viewport_size({'width': 1200, 'height': 440})
        await page.click('[data-tl=chart]')
        await shot('flame-chart')
        await page.click('[data-tab=profile]')
        await page.click('[data-prof=flame]')
        await shot('flame-graph')
        assert not errors, errors
        print(f'Captured five views of {args.unit}; no JavaScript errors.')
        await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report')
    parser.add_argument('--output', default='docs')
    parser.add_argument('--unit', default='PassBuilder.cpp')
    asyncio.run(capture(parser.parse_args()))
