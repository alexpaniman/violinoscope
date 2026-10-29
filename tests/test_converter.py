#!/usr/bin/env python3
"""Runs the converter on made-up traces (synth.py) and checks what it writes for the page.

  python3 -m unittest discover tests
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LABELS = r'^--\s*(?P<group>\S+)\s+(?P<label>\S+), level'


def read_js(path):
    text = Path(path).read_text()
    return json.loads(text[text.index('=') + 1:].rstrip().rstrip(';'))


class Converter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = cls.tmp.name
        subprocess.run([sys.executable, os.path.join(HERE, 'synth.py'), f'{d}/a.jsonl', '--traces', '120', '--group', 'alpha'], check=True)
        subprocess.run([sys.executable, os.path.join(HERE, 'synth.py'), f'{d}/b.jsonl', '--traces', '80', '--group', 'beta',
                        '--seed', '2'], check=True)
        cls.spans = {}
        for name in ('a', 'b'):
            for line in Path(f'{d}/{name}.jsonl').read_text().splitlines():
                s = json.loads(line)
                cls.spans.setdefault(s['traceId'], []).append(s)
        subprocess.run([sys.executable, os.path.join(ROOT, 'violinoscope.py'), f'one={d}/a.jsonl', f'two={d}/b.jsonl',
                        '--unit', 'Handle request', '--label-regex', LABELS, '--cpu-attr', 'app.cpu_us', '-o', f'{d}/out'],
                       check=True, capture_output=True)
        # Without --unit, each trace's root is a unit; here the same span.
        subprocess.run([sys.executable, os.path.join(ROOT, 'violinoscope.py'), f'{d}/a.jsonl', '-o', f'{d}/roots'],
                       check=True, capture_output=True)
        cls.summary = read_js(f'{d}/out/data/summary.js')
        cls.roots = read_js(f'{d}/roots/data/summary.js')
        cls.chunks = []
        k = 0
        while os.path.exists(f'{d}/out/data/trees-{k:04d}.js'):
            text = Path(f'{d}/out/data/trees-{k:04d}.js').read_text()
            cls.chunks.append(json.loads(text[text.index(']=') + 2:].rstrip().rstrip(';')))
            k += 1

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_units_and_failures(self):
        failed = sum(1 for spans in self.spans.values()
                     if any(s['name'] == 'Handle request' and s.get('status', {}).get('code') == 2 for s in spans))
        self.assertEqual(len(self.summary['units']) + len(self.summary['failures']), len(self.spans))
        self.assertEqual(len(self.summary['failures']), failed)
        self.assertTrue(all(f['reason'] == 'Unknown table' for f in self.summary['failures']))

    def test_groups_from_query_text(self):
        self.assertEqual({u['g'] for u in self.summary['units']}, {'alpha', 'beta'})
        self.assertEqual({u['ds'] for u in self.summary['units']}, {'one', 'two'})

    def test_unit(self):
        self.assertEqual(self.summary['meta']['unit'], 'Handle request')
        self.assertEqual(self.roots['meta']['unit'], 'Handle request')
        self.assertEqual(len(self.roots['units']) + len(self.roots['failures']), 120)
        # Without a pattern, every unit is in its input's group.
        self.assertEqual({u['g'] for u in self.roots['units']}, {'a'})

    def test_rows_inside_their_unit(self):
        for c in self.chunks:
            for t in c['trees']:
                rows = t['rows']
                self.assertEqual(rows[1], -1)
                self.assertEqual(rows[2], 0)
                for r in range(1, len(rows) // 5):
                    self.assertLess(rows[5 * r + 1], r)  # a parent comes before its children
                    self.assertGreaterEqual(rows[5 * r + 2], 0)

    def test_trees_hold_every_span_under_the_root(self):
        trees = [t for c in self.chunks for t in c['trees']]
        self.assertEqual(len(trees), len(self.summary['units']))
        for u, t in zip(self.summary['units'], trees):
            self.assertEqual(len(t['rows']) // 5, len(self.spans[u['t']]))

    def test_cpu_attribute(self):
        self.assertTrue(all(u['cpu'] is not None and u['cpu'] > 0 for u in self.summary['units']))


if __name__ == '__main__':
    unittest.main()
