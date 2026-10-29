import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import layouts
import violinoscope


class Portable(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.root = {'traceId':'0123456789abcdef0123456789abcdef', 'spanId':'0123456789abcdef',
                     'name':'Request', 'startTimeUnixNano':'1000000000', 'endTimeUnixNano':'1100000000'}
        self.doc = {'resourceSpans':[{'resource':{'attributes':[{'key':'dataset.name','value':{'stringValue':'Example'}}]},
                                   'scopeSpans':[{'spans':[self.root]}]}]}

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT/'violinoscope.py'), *args], cwd=self.folder,
                              capture_output=True, text=True)

    def test_offline_default_and_layout(self):
        file = self.folder/'spans.json'
        file.write_text(json.dumps(self.doc))
        preset = {'format':'violinoscope-layout','version':1,'unit':'Request','name':'Overview',
                  'paths':[['Request']], 'names':{'s0':'A </script><script>alert(1)</script>'}}
        (self.folder/'layout.json').write_text(json.dumps(preset))
        result = self.run_cli(str(file), '--layout', 'layout.json')
        self.assertEqual(result.returncode, 0, result.stderr)
        html = (self.folder/'violinoscope.html').read_text()
        self.assertNotIn('<script src=', html)
        self.assertNotIn('fonts.googleapis', html)
        self.assertNotIn('A </script>', html)
        self.assertIn('A <\\/script>', html)
        self.assertIn('"ds":"Example"', html)
        self.assertIn('"name":"Overview"', html)
        self.assertFalse((self.folder/'data').exists())

    def test_explicit_dataset_overrides_resource(self):
        file = self.folder/'spans.json'
        file.write_text(json.dumps(self.doc))
        result = self.run_cli('Override='+str(file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"ds":"Override"', (self.folder/'violinoscope.html').read_text())

    def test_reject_wrong_unit_and_corrupt_lines(self):
        (self.folder/'spans.json').write_text(json.dumps(self.doc))
        (self.folder/'wrong.json').write_text(json.dumps({'unit':'Other','layout':{'v':4}}))
        result = self.run_cli('spans.json','--layout','wrong.json')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Layout is for', result.stderr)
        (self.folder/'broken.jsonl').write_text(json.dumps(self.doc)+'\n{invalid}\n')
        result = self.run_cli('broken.jsonl')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('broken.jsonl:2:', result.stderr)

    def test_reject_layout_cycle(self):
        with self.assertRaisesRegex(ValueError, 'cycle'):
            layouts.decode({'unit':'Request','layout':{'v':4,'groups':[['g1','Loop',['Request\x01A']]],
                            'parents':[['g1','Request\x01A\x01B']]}})

    def test_tempo_and_jaeger(self):
        spans = list(violinoscope.spans_from_document({'batches':self.doc['resourceSpans']}))
        self.assertEqual(spans[0]['dataset'], 'Example')
        spans = list(violinoscope.spans_from_document({'trace':self.doc}))
        self.assertEqual(spans[0]['name'], 'Request')
        trace = {'processes':{'p':{'serviceName':'Service'}},'spans':[{'traceID':'1','spanID':'2','processID':'p',
                 'operationName':'Request','startTime':1000,'duration':100,'references':[{'refType':'FOLLOWS_FROM','spanID':'3'}]}]}
        span = list(violinoscope.from_jaeger_trace(trace))[0]
        self.assertEqual(span['dataset'], 'Service')
        self.assertEqual(span['links'], [('3','follows_from')])

    def test_large_collector_batches_and_legacy_cycles(self):
        large = {**self.root, 'attributes':[{'key':'large','value':{'stringValue':'x'*100000}}]}
        doc = {'resourceSpans':[{'scopeSpans':[{'spans':[large]}]}]}
        file = self.folder/'large.jsonl'
        file.write_text('\n'+json.dumps(doc)+'\n'+json.dumps(doc)+'\n')
        self.assertEqual(len(list(violinoscope.read_file(str(file)))), 2)
        with self.assertRaisesRegex(ValueError, 'cycle'):
            layouts.decode({'unit':'Request','layout':{'groups':[
                ['g1','First',['Request\x01A'],{'parent':'g2'}],
                ['g2','Second',['Request\x01B'],{'parent':'g1'}]]}})

    def test_different_roots_require_a_unit(self):
        first = self.doc['resourceSpans'][0]['scopeSpans'][0]['spans']
        first.append({**self.root, 'name':'Another operation','spanId':'123456789abcdef0'})
        file = self.folder/'roots.json'
        file.write_text(json.dumps(self.doc))
        result = self.run_cli(str(file))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('choose --unit', result.stderr)
        first[-1]['status'] = {'code':'STATUS_CODE_ERROR'}
        file.write_text(json.dumps(self.doc))
        result = self.run_cli(str(file))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('choose --unit', result.stderr)

    def test_labels_and_warmup_do_not_depend_on_query_text(self):
        file = self.folder/'labels.jsonl'
        spans = []
        for i, label in enumerate(['00001-q42-warmup.sql', '00001-q42.sql']):
            spans.append({**self.root,'traceId':f'{i+1:032x}', 'attributes':[
                {'key':'query.name','value':{'stringValue':label}},
                {'key':'db.query.text','value':{'stringValue':'redacted'}}]})
        file.write_text('\n'.join(map(json.dumps,spans)))
        result = self.run_cli(str(file),'--label-attr','query.name','--skip-label',r'.*-warmup\.sql$',
                              '--label-regex',r'^\d+-(?P<label>q\d+)')
        self.assertEqual(result.returncode,0,result.stderr)
        html=(self.folder/'violinoscope.html').read_text()
        self.assertIn('"l":"q42"',html)
        self.assertIn('"datasets":[["labels",1]]',html)

    def test_flow_attributes_are_configurable(self):
        child = {**self.root,'spanId':'fedcba9876543210','parentSpanId':self.root['spanId'],'name':'Job',
                 'attributes':[{'key':'custom.flow','value':{'stringValue':'async'}}]}
        root, child = violinoscope.from_otlp_span(self.root), violinoscope.from_otlp_span(child)
        from collections import defaultdict
        children = defaultdict(list, {root['id']:[child]})
        self.assertEqual(violinoscope.analyze_unit(root, children, 'custom.flow')['tree'][1][4], 1)
