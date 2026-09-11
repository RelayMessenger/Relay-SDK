"""Actual sized POSIX PTYs; no Windows interactive claim and no real credentials."""
import argparse, fcntl, json, os, pty, re, select, struct, subprocess, termios, time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--shim',required=True);p.add_argument('--origin',required=True);p.add_argument('--scratch',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
if os.uname().sysname=='Linux' and not os.environ.get('RELAY_DAYTONA_SANDBOX_ID'): raise SystemExit('Linux PTY proof requires owned Daytona')
secret='rly_live_'+'V'*43
report={'platform':os.uname().sysname,'kernel':os.uname().release,'shim':a.shim,'size':[30,120],'cases':[],'windowsInteractiveClaim':False}
ansi=re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
def exercise(name, menu=False, cancel=False):
    config=Path(a.scratch)/(name+'-config.json');home=Path(a.scratch)/(name+'-home');cwd=Path(a.scratch)/(name+'-cwd');home.mkdir(mode=0o700);cwd.mkdir(mode=0o700)
    env=os.environ.copy()
    # This owned PTY models a human terminal, not the agent running the proof.
    # Scrub every signal read by @vercel/detect-agent 1.2.5 and agent-driver.ts,
    # as well as the CI flags this fixture has always removed.
    for key in ['RELAY_AGENT_TOKEN','RELAY_PROFILE','CI','GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','BUILDKITE','TF_BUILD',
                'AI_AGENT','CURSOR_TRACE_ID','CURSOR_AGENT','CURSOR_EXTENSION_HOST_ROLE','GEMINI_CLI',
                'CODEX_SANDBOX','CODEX_CI','CODEX_THREAD_ID','ANTIGRAVITY_AGENT','AUGMENT_AGENT','OPENCODE_CLIENT',
                'CLAUDECODE','CLAUDE_CODE','CLAUDE_CODE_IS_COWORK','REPL_ID','COPILOT_MODEL','COPILOT_ALLOW_ALL',
                'COPILOT_GITHUB_TOKEN']:env.pop(key,None)
    env.update(RELAY_CONFIG_PATH=str(config),RELAY_API_URL=a.origin,HOME=str(home),USERPROFILE=str(home),XDG_CONFIG_HOME=str(home/'.config'),TERM='xterm-256color')
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,120,0,0));before=termios.tcgetattr(slave)
    # The menu case opens the `agents` door: the root menu (Connect, Watch, Exit)
    # no longer lists agents since PR 176; "List saved agents" is the second row here.
    command=[a.shim]+(['agents'] if menu else ['auth','login'])
    child=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,cwd=cwd,start_new_session=True)
    raw=b'';deadline=time.monotonic()+25;offer=False
    def drain(wait=.05):
        nonlocal raw
        if select.select([master],[],[],wait)[0]:
            try:raw+=os.read(master,65536)
            except OSError:pass
    def wait_for(value):
        while value not in ansi.sub(b'',raw):
            drain()
            if child.poll() is not None or time.monotonic()>deadline:raise AssertionError('Expected actual PTY prompt did not appear')
    try:
        # `auth login` never offers the skill (packages/cli/src/interactive.test.ts,
        # '["auth","login"] never asks about the Relay skill'); only connect does, at its end.
        wait_for(b'what would you like to do?' if menu else b'Paste your token')
        during=termios.tcgetattr(slave);assert not during[3]&termios.ECHO,'TTY echo was not disabled'
        if menu:
            os.write(master,b'\x03' if cancel else b'\x1b[B\r') # actual agents menu: select "List saved agents"
        else:
            os.write(master,secret.encode());time.sleep(.05);drain();assert secret.encode() not in raw,'Token echoed before submission'
            os.write(master,b'\x03' if cancel else b'\r')
        if not cancel and not menu:
            wait_for(b'Live view:');os.write(master,b'q') # explicit exit from intended persistent saved-agent view
        while child.poll() is None and time.monotonic()<deadline:drain()
        if child.poll() is None:raise AssertionError('PTY command hung')
        for _ in range(3):drain(.02)
        after=termios.tcgetattr(slave);assert before==after,'Terminal attributes were not restored'
        assert secret.encode() not in raw and secret.encode() not in ansi.sub(b'',raw),'Token appeared in PTY capture'
        assert child.returncode==0,'Unexpected Clack cancellation/success exit'
        if cancel or menu:assert not config.exists(),'Cancellation/read-only menu persisted credentials'
        else:assert json.loads(config.read_text())['profiles']['default']['agent_token']==secret
        if menu and not cancel:assert re.search(rb'"agents"\s*:\s*\[\s*\]',ansi.sub(b'',raw)),'Menu did not invoke read-only local inventory'
        assert not any(home.rglob('SKILL.md')) and not any(cwd.rglob('SKILL.md')),'Declined offer installed a skill'
        report['cases'].append({'name':name,'command':command,'exit':child.returncode,'realPty':True,'ciFlagsRemovedOnlyForThisOwnedPty':True,'echoDisabled':True,'noEcho':True,'terminalRestored':True,'persisted':not(cancel or menu),'skillOfferShownAndDeclined':offer,'capture':raw.decode(errors='replace').replace(secret,'[REDACTED]')})
    except Exception:
        report['failedCase']={'name':name,'command':command,'capture':raw.decode(errors='replace').replace(secret,'[REDACTED]')}
        raise
    finally:
        if child.poll() is None:child.kill();child.wait()
        os.close(master);os.close(slave)
try:
    exercise('hidden-success');exercise('hidden-cancel',cancel=True);exercise('menu-list',menu=True);exercise('menu-cancel',menu=True,cancel=True);report['result']='passed'
except Exception as e:report['result']='failed';report['failure']=str(e).replace(secret,'[REDACTED]')
finally:Path(a.receipt).write_text(json.dumps(report,indent=2));print(json.dumps({'result':report['result'],'receipt':a.receipt}))
raise SystemExit(0 if report['result']=='passed' else 1)
