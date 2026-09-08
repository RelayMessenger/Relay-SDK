"""Owned Linux tmux server only. All tmux commands except -V use the private -S socket."""
import argparse, hashlib, json, os, pty, select, shlex, shutil, signal, struct, subprocess, tempfile, termios, fcntl, time, urllib.request, urllib.parse
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--shim',required=True);p.add_argument('--origin',required=True);p.add_argument('--workspace',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
if os.uname().sysname!='Linux' or not os.environ.get('RELAY_DAYTONA_SANDBOX_ID'):raise SystemExit('tmux proof requires actual owned Daytona Linux')
root=Path(tempfile.mkdtemp(prefix='rly-tmux-'));sock=root/'socket';secret='rly_live_'+'V'*43
base=os.environ.copy()
for key in ['TMUX','TMUX_PANE','RELAY_AGENT_TOKEN','RELAY_PROFILE','CI','GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','BUILDKITE','TF_BUILD']:base.pop(key,None)
base['TERM']='xterm-256color';report={'platform':os.uname().sysname,'socket':str(sock),'privateRoot':str(root),'tmuxVersion':subprocess.check_output(['tmux','-V'],text=True).strip(),'commands':[],'cases':[],'broadNoLossClaim':False};runtime_pane_pid=None

def tm(*args,input=None,check=True):
    command=['tmux','-S',str(sock),'-f','/dev/null',*args]
    r=subprocess.run(command,input=input,capture_output=True,env=base,timeout=20)
    output=(r.stdout+r.stderr).decode(errors='replace');assert secret not in output,'Synthetic token leaked in tmux output'
    report['commands'].append({'command':command,'exit':r.returncode,'output':output})
    if check and r.returncode:raise AssertionError('Owned tmux command failed: '+output)
    return r.stdout.decode(errors='replace')
def capture(name):return tm('capture-pane','-p','-S','-','-t',name)
def wait_for(predicate,seconds=30):
    deadline=time.monotonic()+seconds
    while not predicate():
        if time.monotonic()>deadline:raise AssertionError('Owned tmux proof timed out')
        time.sleep(.1)
def session(name,body):
    script=root/(name+'.sh');script.write_text('set -u\n'+body);script.chmod(0o700)
    tm('new-session','-d','-s',name,'-x','120','-y','30','bash '+shlex.quote(str(script)))
def attach_cycle(name):
    before=tm('display-message','-p','-t',name,'#{pane_id}:#{pane_pid}').strip()
    client_records=[]
    for _ in range(2):
        master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,120,0,0))
        child=subprocess.Popen(['tmux','-S',str(sock),'-f','/dev/null','attach-session','-t',name],stdin=slave,stdout=slave,stderr=slave,env=base,start_new_session=True)
        try:
            wait_for(lambda:bool(tm('list-clients','-F','#{client_tty}').strip()),10)
            os.write(master,b'\x02d') # actual default prefix + detach key in this -f /dev/null server
            child.wait(timeout=10)
            client_records.append({'exit':child.returncode,'actualPtyClient':True})
        finally:
            if child.poll() is None:child.kill();child.wait()
            os.close(master);os.close(slave)
    after=tm('display-message','-p','-t',name,'#{pane_id}:#{pane_pid}').strip();assert before==after
    return {'paneBefore':before,'paneAfter':after,'clients':client_records}
try:
    for name,cancel in [('auth-ok',False),('auth-cancel',True)]:
        home=root/(name+'-home');home.mkdir(mode=0o700);cwd=root/(name+'-cwd');cwd.mkdir(mode=0o700)
        cfg=root/(name+'.json');before=root/(name+'-before');after=root/(name+'-after');code=root/(name+'-exit')
        body=f'export HOME={shlex.quote(str(home))} USERPROFILE={shlex.quote(str(home))} RELAY_CONFIG_PATH={shlex.quote(str(cfg))} RELAY_API_URL={shlex.quote(a.origin)}\ncd {shlex.quote(str(cwd))}\nstty -g >{shlex.quote(str(before))}\n{shlex.quote(a.shim)} auth login\nprintf "%s" "$?" >{shlex.quote(str(code))}\nstty -g >{shlex.quote(str(after))}\nexec sleep 180\n'
        session(name,body);wait_for(lambda:'Agent Token' in capture(name))
        tty=tm('display-message','-p','-t',name,'#{pane_tty}').strip();fd=os.open(tty,os.O_RDWR|os.O_NOCTTY)
        try:assert not termios.tcgetattr(fd)[3]&termios.ECHO
        finally:os.close(fd)
        tm('load-buffer','-b',name+'-secret','-',input=secret.encode());tm('paste-buffer','-b',name+'-secret','-d','-t',name)
        assert secret not in capture(name)
        tm('send-keys','-t',name,'C-c' if cancel else 'Enter')
        if not cancel:
            wait_for(lambda:'Install the Relay skill?' in capture(name));tm('send-keys','-t',name,'Enter')
        wait_for(code.exists);assert code.read_text()=='0';assert before.read_text()==after.read_text();history=capture(name);assert secret not in history
        assert (not cfg.exists()) if cancel else json.loads(cfg.read_text())['profiles']['default']['agent_token']==secret
        assert name+'-secret' not in tm('list-buffers','-F','#{buffer_name}',check=False)
        item={'name':name,'noEchoInPaneOrHistory':True,'terminalRestored':True,'cancelled':cancel,'history':history}
        if not cancel:
            digest=hashlib.sha256(cfg.read_bytes()).hexdigest();item['detachReattach']=attach_cycle(name);assert hashlib.sha256(cfg.read_bytes()).hexdigest()==digest;item['configUnchanged']=True
        report['cases'].append(item)
    pipeenv={**base,'RELAY_CONFIG_PATH':str(root/'pipe.json'),'RELAY_API_URL':a.origin}
    r=subprocess.run([a.shim,'auth','login'],input=b'',capture_output=True,env=pipeenv,timeout=5);assert r.returncode==1
    r=subprocess.run([a.shim,'auth','login','--with-token'],input=(secret+'\n').encode(),capture_output=True,env=pipeenv,timeout=20);assert r.returncode==0 and secret.encode() not in r.stdout+r.stderr
    report['nonTTY']={'noFlagExited':True,'stdinFlagSucceeded':True}
    release=root/'release-runtime';runtime_receipt=root/'runtime.json';runtime_exit=root/'runtime-exit'
    body=f'cd {shlex.quote(a.workspace)}\nexport RELAY_TMUX_PROOF=1 RELAY_RUNTIME_RELEASE_FILE={shlex.quote(str(release))} RELAY_RUNTIME_PROOF_RECEIPT={shlex.quote(str(runtime_receipt))}\nnode scripts/agent-cli-platforms-runtime.mjs\nprintf "%s" "$?" >{shlex.quote(str(runtime_exit))}\nexec sleep 120\n'
    session('runtime',body);runtime_pane_pid=int(tm('display-message','-p','-t','runtime','#{pane_pid}').strip())
    def ready():
        if not runtime_receipt.exists():return False
        try:
            data=json.loads(runtime_receipt.read_text())
            if data.get('result')=='failed':raise AssertionError('Native runtime fixture failed; see retained runtime receipt')
            return data.get('result')=='native-proof-passed-awaiting-tmux-control'
        except json.JSONDecodeError:return False
    wait_for(ready,240);state=json.loads(runtime_receipt.read_text());pid=state['runtimePid'];os.kill(pid,0)
    cycle=attach_cycle('runtime');os.kill(pid,0)
    origin=state['controlOrigin'];assert urllib.parse.urlsplit(origin).hostname=='127.0.0.1'
    with urllib.request.urlopen(urllib.request.Request(origin+'/__verification/next-event',data=b'',method='POST'),timeout=10) as response:assert response.status==200
    def second():
        try:return 'Message send count=2' in json.loads(runtime_receipt.read_text()).get('protocolOutput','')
        except json.JSONDecodeError:return False
    wait_for(second,60);release.touch();wait_for(runtime_exit.exists,20);assert runtime_exit.read_text()=='0'
    final=json.loads(runtime_receipt.read_text());assert final['result']=='passed';assert final['runtimePid']==pid
    report['runtime']={'detachReattach':cycle,'sameGatewayPid':pid,'postReattachEventAckAndReply':True,'runtimeReceipt':str(runtime_receipt),'observedEventsOnly':2}
    report['result']='passed'
except Exception as e:report['result']='failed';report['failure']=str(e).replace(secret,'[REDACTED]')
finally:
    (root/'release-runtime').touch()
    if runtime_pane_pid:
        try:
            if os.getpgid(runtime_pane_pid)==runtime_pane_pid:os.killpg(runtime_pane_pid,signal.SIGTERM)
        except ProcessLookupError:pass
    tm('kill-server',check=False)
    time.sleep(.2)
    report['ownedServerShutdown']=subprocess.run(['tmux','-S',str(sock),'-f','/dev/null','has-session'],env=base,capture_output=True).returncode!=0
    if (root/'runtime.json').exists():
        kept=Path(a.receipt).with_name('tmux-runtime.json');shutil.copyfile(root/'runtime.json',kept)
        if 'runtime' in report:report['runtime']['runtimeReceipt']=str(kept)
    report['ownedSocketGone']=not sock.exists()
    if report.get('result')=='passed':
        assert report['ownedServerShutdown'];shutil.rmtree(root);report['ownedPrivateFixturesRemoved']=True
    Path(a.receipt).write_text(json.dumps(report,indent=2));print(json.dumps({'result':report['result'],'receipt':a.receipt,'ownedSocket':str(sock)}))
raise SystemExit(0 if report['result']=='passed' else 1)
