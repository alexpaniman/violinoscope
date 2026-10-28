#!/usr/bin/env python3
"""Runs the converter on made-up traces (synth.py) and checks what it writes for the page.

  python3 -m unittest discover tests
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read_js(path):
    text = open(path).read()
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
            for line in open(f'{d}/{name}.jsonl'):
                s = json.loads(line)
                cls.spans.setdefault(s['traceId'], []).append(s)
        subprocess.run([sys.executable, os.path.join(ROOT, 'violinoscope.py'), f'one={d}/a.jsonl', f'two={d}/b.jsonl',
                        '--profile', os.path.join(HERE, 'profile.json'), '-o', f'{d}/out'], check=True, capture_output=True)
        cls.summary = read_js(f'{d}/out/data/summary.js')
        cls.names = read_js(f'{d}/out/data/names.js')
        cls.chunks = []
        k = 0
        while os.path.exists(f'{d}/out/data/trees-{k:04d}.js'):
            text = open(f'{d}/out/data/trees-{k:04d}.js').read()
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

    def test_shares(self):
        ids = [c['id'] for c in self.summary['columns']]
        plan, rules = ids.index('plan'), ids.index('rules')
        for u in self.summary['units']:
            self.assertTrue(all(0 <= s <= 1 for s in u['s']), u['s'])
            # A child part lies inside its parent, so it can't take more of the time.
            self.assertLessEqual(u['s'][rules], u['s'][plan] + 1e-3)

    def test_trees_hold_every_span_under_the_root(self):
        trees = [t for c in self.chunks for t in c['trees']]
        self.assertEqual(len(trees), len(self.summary['units']))
        for u, t in zip(self.summary['units'], trees):
            self.assertEqual(len(t['rows']) // 5, len(self.spans[u['t']]))

    def test_cpu_attribute(self):
        self.assertTrue(all(u['cpu'] is not None and u['cpu'] > 0 for u in self.summary['units']))


if __name__ == '__main__':
    unittest.main()
