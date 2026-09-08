import os,pty,subprocess,select,time,termios,fcntl,struct,json,tempfile,pathlib,shutil,signal
if os.uname().sysname=='Linux' and not os.environ.get('RELAY_DAYTONA_SANDBOX_ID'): raise SystemExit('Linux PTY proof requires owned Daytona')
root=pathlib.Path(tempfile.mkdtemp(prefix='relay-installed-terminal-')); dest=pathlib.Path(os.environ.get('RELAY_TERMINAL_EVIDENCE','/home/daytona/terminal-installed-evidence'));dest.mkdir(exist_ok=True,parents=True)
node=os.environ.get('RELAY_TERMINAL_NODE','/usr/local/share/nvm/versions/node/v22.22.3/bin/node');shim=os.environ.get('RELAY_TERMINAL_SHIM','/home/daytona/terminal-installed/node_modules/.bin/relaymessenger');results=[]
baseenv={k:v for k,v in os.environ.items() if k in ['PATH','LANG','LC_ALL','RELAY_TERMINAL_SOURCE']};baseenv['PATH']=str(pathlib.Path(node).parent)+':'+baseenv.get('PATH','/usr/bin:/bin')
def drain(fd,seconds):
 end=time.monotonic()+seconds;out=b''
 while time.monotonic()<end:
  if select.select([fd],[],[],min(.05,max(0,end-time.monotonic())))[0]:
   try:out+=os.read(fd,65536)
   except OSError:break
 return out
steps=[(b'what would you like to do?',b'\r'),(b'Install the Relay skill?',b'n\r'),(b'Handle (optional)',b'\r'),(b'Name (optional)',b'\r'),(b'Image (optional)',b'\r')]
modes=[('light',80,24),('dark',100,32)]+([('tmux',100,32)] if os.uname().sysname=='Linux' else [])
for mode,columns,rows in modes:
 home=root/mode;home.mkdir();ready=home/'ready.json';report=home/'server.json';socket=home/'tmux.sock';env={**baseenv,'HOME':str(home),'TERM':'xterm-256color','COLORFGBG':'0;15' if mode=='light' else '15;0','RELAY_CONFIG_PATH':str(home/'config.json')}
 server=subprocess.Popen([node,str(pathlib.Path(__file__).with_name('agent-cli-platforms-terminal-server.mjs')),str(ready),str(report)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 def tmux(*args,check=True):return subprocess.run(['tmux','-S',str(socket),*args],env=env,capture_output=True,text=True,check=check)
 master=slave=None;process=None;output=b''
 try:
  end=time.monotonic()+5
  while not ready.exists() and time.monotonic()<end:time.sleep(.05)
  env['RELAY_API_URL']=json.loads(ready.read_text())['origin'];master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0));before=termios.tcgetattr(slave)
  if mode=='tmux':
   tmux('new-session','-d','-s','terminal','-x',str(columns),'-y',str(rows),f'{shim}; sleep 10')
   process=subprocess.Popen(['tmux','-S',str(socket),'attach-session','-t','terminal'],stdin=slave,stdout=slave,stderr=slave,env=env)
  else:process=subprocess.Popen([shim],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=home)
  stage=0;end=time.monotonic()+20
  while time.monotonic()<end:
   output+=drain(master,.08)
   if stage<len(steps) and steps[stage][0] in output:os.write(master,steps[stage][1]);stage+=1
   if stage==len(steps) and b'owned integrated observer event' in output:break
   if process.poll() is not None:break
  assert stage==5 and b'owned integrated observer event' in output,{'mode':mode,'stage':stage,'exit':process.poll()}
  state=json.loads(report.read_text());assert state['creates']==1 and state['observers']==1 and state['authConfirmed'] and state['queries']==['/v1/websocket?observe=true'] and state['frames']==[],state
  assert b'Create a new agent at' not in output and b'rly_live_'+b'P'*43 not in output
  assert output.index(b'Install the Relay skill?')<output.index(b'Handle (optional)')
  # Inspect latest alternate-screen frame, not old prompts/history.
  frame=output.split(b'\x1b[H\x1b[2J')[-1]
  assert b'Enlarge terminal' not in frame and ('▄'.encode() in frame or '▀'.encode() in frame),frame
  assert b'https://staging.relayapp.im/' in output and b'Runtime: not started' in output
  detail={'mode':mode,'size':[columns,rows],'inputSteps':stage,'installedShim':True,'skillBeforeCreate':True,'noExtraCreateConfirmation':True,'apexURL':True,'QRfits':True,'eventsVisible':True,'noTokenEcho':True}
  if mode=='tmux':
   os.write(master,b'\x02d');output+=drain(master,.3);process.wait(timeout=3)
   pre=json.loads(report.read_text())['eventsSent'];time.sleep(.8);post=json.loads(report.read_text())['eventsSent'];assert post>pre
   process=subprocess.Popen(['tmux','-S',str(socket),'attach-session','-t','terminal'],stdin=slave,stdout=slave,stderr=slave,env=env);reattached=drain(master,.5);output+=reattached;assert b'owned integrated observer event' in reattached
   detail.update(actualDetachReattach=True,eventsSentWhileDetached=post-pre)
  os.write(master,b'q');output+=drain(master,.6)
  if mode=='tmux':
   pane=tmux('capture-pane','-p','-t','terminal').stdout;assert 'Stopped viewing' in pane
   tmux('kill-session','-t','terminal')
  assert process.wait(timeout=4)==0;assert termios.tcgetattr(slave)==before
  state=json.loads(report.read_text());assert state['frames']==[];saved=(home/'config.json').read_bytes();assert b'rly_live_'+b'P'*43 in saved
  # Same saved identity in real nonTTY command must exit, not open another observer.
  nonTTY=subprocess.run([shim,'--profile','terminal_fixture.dev','auth','status'],env=env,cwd=home,input='',capture_output=True,text=True,timeout=5);assert nonTTY.returncode==0
  assert json.loads(report.read_text())['observers']==1 and (home/'config.json').read_bytes()==saved
  detail.update(rawRestored=True,configPreserved=True,nonTTYNoNewObserver=True,noACK=True,server=state);results.append(detail)
 finally:
  (dest/(mode+'.ansi')).write_bytes(output.replace(b'rly_live_'+b'P'*43,b'[REDACTED]'))
  if mode=='tmux':tmux('kill-server',check=False)
  if process and process.poll() is None:process.terminate();process.wait(timeout=3)
  server.terminate();server.wait(timeout=3)
  if master is not None:os.close(master)
  if slave is not None:os.close(slave)
shutil.rmtree(root)
receipt={'passed':True,'scope':'actual installed CLI root menu, loopback HTTP/observer only; no deployed Server claim','results':results,'ownedFixturesRemoved':not root.exists(),'ownedSocketGone':not socket.exists()};(dest/'receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt,indent=2))
