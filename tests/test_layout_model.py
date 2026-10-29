"""The browser and converter must accept and reject the same portable definitions."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import layouts


class LayoutValidation(unittest.TestCase):
    def test_python_and_javascript_agree(self):
        a,b,x='R\x01A','R\x01B','R\x01A\x01X'
        cases=[
            (True,{'groups':[['g1','Union',[a,b]]]}),
            (True,{'v':6,'groups':[['g1','Mixed',[{'span':a,'cuts':[['span',x]]},{'violin':b}]]]}),
            (True,{'v':6,'definitions':[[a,[{'span':a}]]],'retained':[[b,[['span',a]]]]}),
            (False,{'groups':[['g1','One',['g2']],['g2','Two',['g1']],['g3','Three',['g1']]]}),
            (False,{'groups':[['g1','Bad',['\x02R\x01A']]]}),
            (False,{'groups':[['g1','Bad',[a],{'tree':2}]]}),
            (False,{'except':[['R',[a]]]}),
            (False,{'retained':[['R',[['span',a]]]]}),
            (False,{'skip':['R']}),
            (False,{'parents':[[a,'R'],[a,b]]}),
            (False,{'groups':[['g1','Bad',[a]]],'bounds':[[b,['g1']]]}),
            (False,{'groups':[['g1','Bad',[b]]],'parents':[['g1',a]]}),
            (False,{'v':6,'definitions':[['_all',[{'span':a}]]]}),
            (False,{'v':6,'groups':[['g1','Bad',[{'violin':a,'cuts':[['span',x]]}]]]}),
            (False,{'v':6,'groups':[['g1','Bad',[{'span':a,'cuts':[['span','\x02bad!\x03'+x]]}]]]}),
        ]
        docs=[{'unit':'R','layout':{'v':6,**state}} for _,state in cases]
        script="""const fs=require('fs'),vm=require('vm');const c={window:{}};vm.runInNewContext(fs.readFileSync('web/definition-model.js','utf8'),c);
        const docs=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(docs.map(d=>{try{c.window.ViolinDefinitions.validate(d.unit,d.layout);return true;}catch(e){return false;}})));"""
        result=subprocess.run(['node','-e',script],cwd=ROOT,input=json.dumps(docs),text=True,capture_output=True,check=True)
        js=json.loads(result.stdout)
        for i,((expected,_),doc) in enumerate(zip(cases,docs)):
            with self.subTest(case=i):
                try:layouts.decode(doc);accepted=True
                except (ValueError,TypeError,KeyError):accepted=False
                self.assertEqual(accepted,expected)
                self.assertEqual(js[i],expected)

    def test_typed_sources_and_remainders_roundtrip_from_portable(self):
        doc={'format':'violinoscope-layout','version':3,'unit':'R','name':'Overview','paths':[['R','A'],['R','A','X'],['R','B']],
             'groups':[{'id':'g1','name':'Parts','inputs':[{'span':'s0','cuts':[['span','s1']]},{'violin':'s2'}]}],
             'shown':['g1',layouts.rest('g1','s0')]}
        decoded=layouts.decode(doc)['layout']
        self.assertEqual(decoded['groups'][0][2][0],{'span':'R\x01A','cuts':[['span','R\x01A\x01X']]})
        self.assertEqual(layouts.rest_parts(decoded['shown'][1]),['g1','R\x01A'])
