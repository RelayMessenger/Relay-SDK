"""Real owned POSIX PTYs. No simulated Windows claim; only synthetic fixture credentials."""
import argparse, json, os, pty, select, subprocess, termios, time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--shim',required=True);p.add_argument('--origin',required=True);p.add_argument('--scratch',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
if os.uname().sysname=='Linux' and not os.environ.get('RELAY_DAYTONA_SANDBOX_ID'): raise SystemExit('Linux PTY proof requires owned Daytona')
secret='rly_live_'+'V'*43
report={'platform':os.uname().sysname,'kernel':os.uname().release,'shim':a.shim,'cases':[],'windowsInteractiveClaim':False}
def exercise(name, cancel=False):
    config=Path(a.scratch)/(name+'-config.json')
    env=os.environ.copy();env.pop('RELAY_AGENT_TOKEN',None);env.pop('RELAY_PROFILE',None)
    env['RELAY_CONFIG_PATH']=str(config);env['RELAY_API_URL']=a.origin;env['TERM']='xterm-256color'
    master,slave=pty.openpty(); before=termios.tcgetattr(slave)
    child=subprocess.Popen([a.shim,'auth','login'],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
    raw=b''; deadline=time.monotonic()+15
    def drain(wait=.05):
        nonlocal raw
        if select.select([master],[],[],wait)[0]:
            try: raw+=os.read(master,65536)
            except OSError: pass
    try:
        while b'Agent Token (hidden): ' not in raw:
            drain()
            if child.poll() is not None or time.monotonic()>deadline: raise AssertionError('Hidden prompt did not appear on actual PTY')
        during=termios.tcgetattr(slave)
        assert not during[3]&termios.ECHO, 'TTY echo was not disabled'
        os.write(master, secret.encode())
        time.sleep(.05);drain()
        assert secret.encode() not in raw,'Token echoed before submission'
        os.write(master,b'\x03' if cancel else b'\r')
        while child.poll() is None and time.monotonic()<deadline: drain()
        if child.poll() is None: raise AssertionError('PTY command hung')
        for _ in range(3):drain(.02)
        after=termios.tcgetattr(slave)
        assert before==after, 'Terminal attributes were not restored'
        assert secret.encode() not in raw, 'Token appeared in PTY capture'
        assert child.returncode==(1 if cancel else 0), 'Unexpected PTY exit'
        if cancel: assert not config.exists(), 'Cancellation persisted credentials'
        else: assert json.loads(config.read_text())['profiles']['default']['agent_token']==secret
        report['cases'].append({'name':name,'exit':child.returncode,'realPty':True,'echoDisabled':True,'noEcho':True,'terminalRestored':True,'persisted':not cancel,'capture':raw.decode(errors='replace').replace(secret,'[REDACTED]')})
    finally:
        if child.poll() is None: child.kill();child.wait()
        os.close(master);os.close(slave)
try:
    exercise('hidden-success');exercise('hidden-cancel',True);report['result']='passed'
except Exception as e:
    report['result']='failed';report['failure']=str(e).replace(secret,'[REDACTED]')
finally:
    Path(a.receipt).write_text(json.dumps(report,indent=2));print(json.dumps({'result':report['result'],'receipt':a.receipt}))
raise SystemExit(0 if report['result']=='passed' else 1)
