from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from trace_formats import chrome_spans, perf_spans


class Formats(unittest.TestCase):
    def test_chrome_nesting_precision_and_aggregate_counters(self):
        doc = {'beginningOfTime':1700000000000000,'traceEvents':[
            {'ph':'X','name':'Child','ts':1.001,'dur':2.002},
            {'ph':'X','name':'Root','ts':0,'dur':10},
            {'ph':'X','name':'Total Root','ts':0,'dur':10,'args':{'count':1}},
            {'ph':'B','name':'Duration','ts':5}, {'ph':'E','ts':7},
        ]}
        spans = list(chrome_spans(doc,'one.json'))
        self.assertEqual([s['name'] for s in spans],['Root','Child','Duration'])
        self.assertEqual(spans[1]['start']-spans[0]['start'],1001)
        self.assertEqual(spans[1]['end']-spans[1]['start'],2002)
        self.assertEqual(spans[1]['parent'],spans[0]['id'])
        self.assertEqual(spans[0]['attrs']['job.name'],'one')
        self.assertNotEqual(spans[0]['trace'], next(chrome_spans(doc,'two.json'))['trace'])

    def test_chrome_threads_and_unfinished_events(self):
        spans = list(chrome_spans([{'ph':'X','name':'Root','ts':0,'dur':10,'tid':1},
                                  {'ph':'X','name':'Other','ts':1,'dur':2,'tid':2}]))
        self.assertEqual([s['parent'] for s in spans],['',''])
        with self.assertRaisesRegex(ValueError,'unfinished'):
            list(chrome_spans([{'ph':'B','name':'Start','ts':0}]))

    def test_perf_periods_coalesce_common_stack_and_ignore_wall_gaps(self):
        text = '''clang++ 100/101 1.000000: 1000000 cpu-clock:u:
            aa leaf+0x10 (/clang)
            bb main (/clang)

clang++ 100/101 2.000000: 2000000 cpu-clock:u:
            cc other (/clang)
            bb main (/clang)

clang++ 100/102 2.500000: 500000 task-clock:u:
            dd worker (/clang)
'''
        spans = list(perf_spans(text.splitlines()))
        root,main,leaf,other,worker_root,worker = spans
        self.assertEqual(root['end']-root['start'],3000000)
        self.assertEqual(main['end']-main['start'],3000000)
        self.assertEqual(leaf['name'],'leaf')
        self.assertEqual(leaf['end'],other['start'])
        self.assertEqual(leaf['parent'],main['id'])
        self.assertNotEqual(worker_root['trace'],root['trace'])
        self.assertEqual(worker_root['attrs']['profile.kind'],'sampled_cpu')

    def test_perf_rejects_cycles_and_malformed_samples(self):
        with self.assertRaisesRegex(ValueError,'not cycles'):
            list(perf_spans(['clang 1/1 1.000: 123 cycles:u:']))
        with self.assertRaisesRegex(ValueError,'unrecognized'):
            list(perf_spans(['unrecognized input']))


if __name__ == '__main__':
    unittest.main()
