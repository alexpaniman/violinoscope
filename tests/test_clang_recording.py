import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest


LAUNCHER = Path(__file__).resolve().parents[1] / 'examples/clang/record.py'


class Recording(unittest.TestCase):
    def test_outputs_exit_codes_and_crashes_survive_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root/'config.json'
            config.write_text(json.dumps({'output':str(root/'recordings')}))
            source = root/'source file.cpp'
            source.write_text('int main() {}\n')
            compiler = root/'compiler.py'
            compiler.write_text('''import json,os,resource,signal,sys
from pathlib import Path
for arg in sys.argv:
    if arg.startswith('-ftime-trace='): Path(arg.split('=',1)[1]).write_text('{}')
print('compiler output',flush=True)
print('compiler diagnostic',file=sys.stderr,flush=True)
if '--crash' in sys.argv:
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    os.kill(os.getpid(),signal.SIGABRT)
sys.exit(7 if '--fail' in sys.argv else 0)
''')
            for flag, expected in [('',0), ('--fail',7), ('--crash',-signal.SIGABRT)]:
                command = [sys.executable,str(compiler),str(source),flag]
                result = subprocess.run([sys.executable,str(LAUNCHER),str(config),'--',*command], capture_output=True, text=True)
                self.assertEqual(result.returncode, expected)
                self.assertEqual(result.stdout, 'compiler output\n')
                self.assertEqual(result.stderr, 'compiler diagnostic\n')
            records = [json.loads(p.read_text()) for p in (root/'recordings/metadata/Build').glob('*.json')]
            self.assertEqual(sorted(r['returncode'] for r in records), [-signal.SIGABRT,0,7])
            self.assertTrue(all(r['trace'] and r['command'][2] == str(source) for r in records))

    def test_response_files_and_informational_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root/'config.json'
            config.write_text(json.dumps({'output':str(root/'recordings')}))
            response = root/'flags.rsp'
            response.write_text('"source file.cpp" -O2')
            command = [sys.executable,'-c','import json,sys; print(json.dumps(sys.argv[1:]))','@'+str(response)]
            def run(extra):
                result = subprocess.run([sys.executable,str(LAUNCHER),str(config),'--',*command,*extra], capture_output=True, text=True, check=True)
                return json.loads(result.stdout)
            self.assertEqual(run(['-###']), ['@'+str(response),'-###'])
            self.assertFalse((root/'recordings').exists())
            args = run([])
            self.assertEqual(args[0], '@'+str(response))
            self.assertTrue(any(a.startswith('-ftime-trace=') for a in args))
            args = run(['--', 'another.c'])
            self.assertLess(next(i for i,a in enumerate(args) if a.startswith('-ftime-trace=')),args.index('--'))
            records = list((root/'recordings/metadata/Build').glob('*.json'))
            self.assertEqual(len(records),2)
            self.assertTrue(any(json.loads(r.read_text())['source'].endswith('/source file.cpp') for r in records))
