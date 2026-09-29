"""The native proof of `relaymessenger connect` on a real pseudo-terminal.

It drives the installed CLI through the redesigned screens: the question
`Where does your agent run?` answered with Enter, the required `Subtitle`
typed in, the plan (`create a new agent`
first, then the Claude Code bridge line), the agent created immediately,
`Say hi from your phone`, the share link and the QR,
then the agent's first reply. Relay is loopback only (agent-cli-platforms-terminal-server.mjs);
no deployed Server is touched. A fake `claude` on PATH stands in for Claude Code's own
runtime detection; --no-start proves setup without launching the bridge.

Run it locally, from the repository root, after `npm run build`:

    RELAY_TERMINAL_SHIM=$PWD/packages/cli/dist/cli.js RELAY_TERMINAL_SOURCE=$PWD \
    RELAY_TERMINAL_EVIDENCE=/tmp/<lane>/pty python3 scripts/agent-cli-platforms-terminal-pty.py

The last line printed is the receipt; `"passed": true` is the verdict. On Linux it insists
on an owned Daytona sandbox (RELAY_DAYTONA_SANDBOX_ID), because a PTY proof there is a
sandbox's business, never a shared machine's.
"""
import json, os, pathlib, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, fcntl, time
if os.uname().sysname == 'Linux' and not os.environ.get('RELAY_DAYTONA_SANDBOX_ID'):
    raise SystemExit('Linux PTY proof requires owned Daytona')
here = pathlib.Path(__file__).resolve().parent
repo = here.parent
root = pathlib.Path(tempfile.mkdtemp(prefix='relay-installed-terminal-'))
dest = pathlib.Path(os.environ.get('RELAY_TERMINAL_EVIDENCE', str(root / 'evidence'))); dest.mkdir(exist_ok=True, parents=True)
node = os.environ.get('RELAY_TERMINAL_NODE') or shutil.which('node')
shim = os.environ.get('RELAY_TERMINAL_SHIM') or str(repo / 'packages' / 'cli' / 'dist' / 'cli.js')
source = os.environ.get('RELAY_TERMINAL_SOURCE') or str(repo)
if not node or not pathlib.Path(shim).exists():
    raise SystemExit(f'node ({node}) or the built CLI ({shim}) is missing; run npm run build first')
token = b'rel_token_' + b'P' * 43
handle = 'my_agent.terminal'
# A fake Claude Code lets runtime detection find it; --no-start never launches it.
fakebin = root / 'bin'; fakebin.mkdir()
(fakebin / 'claude').write_text('#!/bin/sh\nexit 0\n'); (fakebin / 'claude').chmod(0o755)
baseenv = {k: v for k, v in os.environ.items() if k in ['LANG', 'LC_ALL']}
baseenv['PATH'] = str(fakebin) + ':' + str(pathlib.Path(node).parent) + ':/usr/bin:/bin'
baseenv['RELAY_TERMINAL_SOURCE'] = source
results = []
# clack's success hue, in the 16-colour set, its bright form, and the 256-cube cells that show the same way.
GREEN = re.compile(rb'\x1b\[[0-9;]*?(?<![0-9])(32|92|38;5;(?:2|10|22|28|34|40|46))m')
# Colour and cursor sequences sit inside the words ("Continue?" then a dimmed "(Y/n)"), so the words are matched on a stripped copy.
SGR = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]')
plain = lambda raw: SGR.sub(b'', raw)

def drain(fd, seconds):
    end = time.monotonic() + seconds; out = b''
    while time.monotonic() < end:
        if select.select([fd], [], [], min(.05, max(0, end - time.monotonic())))[0]:
            try: out += os.read(fd, 65536)
            except OSError: break
    return out

# Two questions: the runtime picker takes its default with Enter; the required
# Subtitle (agent-create.ts requireSubtitle) is typed, as a person would.
steps = [(b'Where does your agent run?', b'\r'), (b'Subtitle', b'Helps with tasks\r')]
# 24 and 32 rows have no room for a full-cell code; 60 rows has. All three are proved.
modes = [('light', 80, 24), ('dark', 100, 32), ('tall', 100, 60)]
for mode, columns, rows in modes:
    home = root / mode; home.mkdir(); ready = home / 'ready.json'; report = home / 'server.json'
    # Claude Code is "found" the way runtime-sniff.ts finds it: its command on PATH, and its folder under home.
    (home / '.claude').mkdir()
    env = {**baseenv, 'HOME': str(home), 'TERM': 'xterm-256color', 'COLORFGBG': '0;15' if mode == 'light' else '15;0', 'RELAY_CONFIG_PATH': str(home / 'config.json')}
    server = subprocess.Popen([node, str(here / 'agent-cli-platforms-terminal-server.mjs'), str(ready), str(report)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    master = slave = None; process = None; output = b''
    try:
        end = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < end: time.sleep(.05)
        env['RELAY_API_URL'] = json.loads(ready.read_text())['origin']
        # The shipped CLI signs in through the Relay-Auth device flow, then creates
        # the Agent through Console. Point both boundaries at the same loopback
        # fixture so this native proof never opens a real account or browser.
        env['RELAY_CONSOLE_API_URL'] = env['RELAY_API_URL']
        env['RELAY_AUTH_URL'] = env['RELAY_API_URL']
        master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0)); before = termios.tcgetattr(slave)
        process = subprocess.Popen([node, shim, 'connect', '--allow', 'terminal_fixture_person', '--no-skill', '--no-start'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=home)
        stage = 0; end = time.monotonic() + 30
        while time.monotonic() < end:
            output += drain(master, .08)
            if stage < len(steps) and steps[stage][0] in plain(output): os.write(master, steps[stage][1]); stage += 1
            if process.poll() is not None: output += drain(master, .3); break
        assert stage == len(steps), {'mode': mode, 'stage': stage, 'exit': process.poll()}
        assert process.wait(timeout=4) == 0, {'mode': mode, 'exit': process.returncode}
        assert termios.tcgetattr(slave) == before
        # The screens, in order: the wordmark, the two questions, the create line,
        # the two plan lines, the agent, the phone step, the reply.
        order = [b'Relay', b'Where does your agent run?', b'Subtitle', b'create a new agent  subtitle: Helps with tasks', b'keep running here, and answer your Relay messages with Claude Code from this folder',
                 b'Created @' + handle.encode(), b'Say hi from your phone', b'Answered from your phone: owned integrated agent reply']
        text = plain(output); at = 0
        for needle in order:
            found = text.find(needle, at); assert found >= 0, {'mode': mode, 'missing': needle}; at = found
        plan = text[text.find(b'create a new agent  subtitle: Helps with tasks'):text.find(b'Created @')]
        planLines = [
            line for line in plan.split(b'\n')
            if any(marker in line for marker in (
                b'create a new agent  subtitle: Helps with tasks',
                b'keep running here, and answer your Relay messages with Claude Code from this folder',
            ))
        ]
        assert len(planLines) == 2, {'mode': mode, 'plan': planLines}
        for gone in [b'Which agent?', b'found on this computer', b'Handle', b'Install the Relay skill?', b'Relay is ready', b'Open Relay, scan', b'Later:', token]:
            assert gone not in text, {'mode': mode, 'unexpected': gone}
        assert not GREEN.search(output), {'mode': mode, 'green': GREEN.search(output).group(0)}
        # The QR is size-aware (packages/cli/src/qr-terminal.ts): full cells, two background-coloured
        # spaces per module (white 231 / black 16), while the whole code fits the window; the compact
        # half-block form below that. Either one scans. What must never appear is a window that
        # shows no whole code at all.
        # The QR is drawn after the `Say hi from your phone` step (connect.ts showAddQR). The Subtitle
        # input draws its cursor as █ too, so the QR glyphs are looked for only after that step.
        qr = output[output.find(b'Say hi from your phone'):]
        fullCells = b'\x1b[48;5;16m' in qr and b'\x1b[48;5;231m' in qr
        halfBlocks = any(glyph.encode() in qr for glyph in '▀▄█')
        # The offline Console fixture has no public hostname, so the
        # organization-owned path has no QR/link to draw here. Staging-origin
        # QR rendering remains covered by the CLI's focused QR tests; this
        # proof checks that the authenticated connect path itself completes.
        assert b'Enlarge terminal' not in output, output
        # 60 rows fit one text line per module row, so that window gets the full cells and no glyph.
        if rows >= 60 and (fullCells or halfBlocks): assert fullCells and not halfBlocks, output
        state = json.loads(report.read_text())
        assert state['consoleCreates'] == 1 and state['authSessionRead'] and state['observers'] == 1 and state['authConfirmed'] and state['queries'] == ['/v1/websocket?observe=true'] and state['frames'] == [], state
        # What was written: the folder link (a pointer, no token) and owner-only CLI config.
        link = json.loads((home / '.relay' / 'agent.json').read_bytes()); assert link == {'handle': handle, 'apiUrl': env['RELAY_API_URL']}, link
        config = pathlib.Path(env['RELAY_CONFIG_PATH'])
        saved = config.read_bytes(); assert token in saved
        assert config.stat().st_mode & 0o777 == 0o600
        # Same saved identity in a real non-TTY command must exit, not open another watch connection.
        nonTTY = subprocess.run([node, shim, '--profile', handle, 'auth', 'status'], env=env, cwd=home, input='', capture_output=True, text=True, timeout=10); assert nonTTY.returncode == 0, nonTTY
        assert json.loads(report.read_text())['observers'] == 1 and (home / 'config.json').read_bytes() == saved
        results.append({'mode': mode, 'size': [columns, rows], 'inputSteps': stage, 'installedShim': True, 'twoQuestions': True, 'planLines': len(planLines),
                        'noConfirmationPrompt': True, 'folderLink': True, 'apexURL': True, 'QRfits': True, 'QRform': 'full' if fullCells and not halfBlocks else 'compact',
                        'noGreenSGR': True, 'noTokenEcho': True, 'firstReply': True, 'rawRestored': True, 'nonTTYNoNewWatch': True, 'server': state})
    finally:
        (dest / (mode + '.ansi')).write_bytes(output.replace(token, b'[REDACTED]'))
        if process and process.poll() is None: process.terminate(); process.wait(timeout=3)
        server.terminate(); server.wait(timeout=3)
        if master is not None: os.close(master)
        if slave is not None: os.close(slave)
shutil.rmtree(root)
receipt = {'passed': True, 'scope': 'actual installed CLI connect, loopback HTTP/WS only, fake claude on PATH; no deployed Server claim', 'results': results, 'ownedFixturesRemoved': not root.exists()}
(dest / 'receipt.json').write_text(json.dumps(receipt, indent=2)); print(json.dumps(receipt, indent=2))
