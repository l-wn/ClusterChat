#!/usr/bin/env bash
# Run a ClusterChat GPU peer on a rented, headless GPU machine. This file is
# self-contained: copy it over with scp, then
#
#   ./setup-gpu-peer.sh install      once: Chrome, the Vulkan loader, an NVIDIA ICD
#   ./setup-gpu-peer.sh start        headless Chrome on the peer page, in the background
#
# Or drive a rented machine from your own, giving it the ssh command the
# provider handed you. This copies this file over and runs it there:
#
#   ./setup-gpu-peer.sh remote ssh -p 55665 root@1.2.3.4 -L 8080:localhost:8080
#   ./setup-gpu-peer.sh remote status ssh -p 55665 root@1.2.3.4
#   ./setup-gpu-peer.sh remote tunnel ssh -p 55665 root@1.2.3.4
#
# Only the parts of that command needed to reach the machine are used: -i, -o,
# -F, -J and the port are kept and used for both the scp and the ssh, while
# port forwards, -N, -T and a trailing remote command are ignored, since this
# script makes its own connections. If the login needs an explicit key, give
# the -i you would give ssh:
#
#   ./setup-gpu-peer.sh remote ssh -i ~/.ssh/vast_key -p 55665 root@1.2.3.4
#
# With several machines, keep their ssh commands in a file, one per line, and
# name the file instead. Every action then runs on all of them, and `tunnel`
# forwards each machine's DevTools port to a local port of its own:
#
#   ./setup-gpu-peer.sh remote gpus.txt
#
# It asks which cluster the peers should join before it touches anything: paste
# the invite link from a private cluster's Invite button, or press Enter for
# the global mesh. The peers are then started on that link with ?direct=1
# added, and the link is kept on each machine, so restart stays on the same
# cluster.
#
# If the site is behind basic auth, start asks for the password once (or reads
# CHAT_PASS from the environment) and keeps it for restarts.
#
# The page opens on the welcome popup (how much GPU memory to lend, and
# pressing Join is the agreement to the terms), and the GPU is not used until
# it is answered. `answer` presses it over the DevTools protocol:
#
#   ./setup-gpu-peer.sh answer           as much as the slider allows
#   GB=16 ./setup-gpu-peer.sh answer     that much
#
# which `remote` runs for you after start, so a rented machine needs no
# clicking at all. ANSWER=0 leaves the popup alone, and `remote tunnel`
# forwards DevTools to your own Chrome, which is also how to look at a page
# that has already joined:
#
#   local Chrome → chrome://inspect → Configure… → add localhost:9222 → inspect
#
# The DevTools port listens only on the GPU machine's loopback, so that tunnel
# is the only way in from outside. The tab keeps serving until
# `./setup-gpu-peer.sh stop`.

set -euo pipefail

# ?direct=1 lets this peer link directly to other direct peers (GPU to GPU),
# falling back to the TURN relay when they cannot reach each other. It shows
# this machine's address to the tabs it links to; visitors stay relay-only.
URL_DEFAULT='https://clusterchat.io/chat?direct=1'
PORT=${PORT:-9222}
STATE=${STATE:-$HOME/.chattorrent-peer}
PROFILE=$STATE/chrome-profile
LOG=$STATE/chrome.log
PIDFILE=$STATE/chrome.pid
AUTHFILE=$STATE/auth
URLFILE=$STATE/url

usage() {
    cat <<EOF
Usage: ./setup-gpu-peer.sh [install|start [URL]|stop|restart [URL]|status|answer|logs|forget]
       ./setup-gpu-peer.sh remote [up|install|start|stop|restart|status|answer|logs|forget|tunnel] <ssh command | file of them>

  install   install google-chrome and the Vulkan loader (apt), and add an NVIDIA
            Vulkan ICD file if the driver has none (common in rented containers)
  start     launch headless Chrome on URL in the background, DevTools on
            localhost:$PORT. URL can be a private cluster's invite link, whose
            #mesh=… fragment is kept and ?direct=1 added; with no URL it is the
            one the last start was given, or $URL_DEFAULT.
            If the site is behind its password gate, give the login once (see
            below); the login and the URL are kept in \$STATE (mode 600), so
            restart needs nothing and stays on the same cluster
  forget    delete the saved login and cluster link
  stop      stop that Chrome
  restart   stop, then start
  status    running or not, and which GPU the page got
  answer    press the welcome popup's Join over the DevTools protocol, lending
            \$GB (default: as much as the slider allows). As in the page, that
            is the agreement to the terms. Needs python3, which install adds
  logs      follow the page's console output (Ctrl-C to stop watching)

  remote    run any of the above on a rented machine instead of here: copy this
            file over with scp, then run it there over ssh. Give it the ssh
            command your provider handed you, as-is, after the action:

              ./setup-gpu-peer.sh remote ssh -p 55665 root@1.2.3.4 -L 8080:localhost:8080
              ./setup-gpu-peer.sh remote ssh -i ~/.ssh/key -p 55665 root@1.2.3.4

            -i, -o, -F, -J and the port are kept and used for the scp as well;
            port forwards, -N, -T and a trailing remote command are ignored. It
            prints which machine, port and key it understood. With no
            action that means "up": install if Chrome is missing, then start,
            then answer the welcome popup on the machine itself, so there is
            nothing left to click. ANSWER=0 leaves the popup, and the action
            "tunnel" forwards DevTools to your own Chrome to look at a page.

            For several machines, pass a file of ssh commands instead of one
            command: one per line, a line ending in ":" labelling the lines
            under it, # comments and blank lines skipped. Every action runs on
            all of them, a dead machine failing its own line and not the run,
            and "tunnel" forwards machine n to local port \$PORT + n.

              ./setup-gpu-peer.sh remote gpus.txt
              ./setup-gpu-peer.sh remote status gpus.txt

            up, start and restart ask which cluster to join before touching
            anything: paste a private cluster's invite link, or press Enter for
            the global mesh. The login and the invite link are asked for here
            and written to the remote \$STATE over the ssh pipe, so neither is
            in a command line on either machine.

Environment:
  CHAT_USER, CHAT_PASS   the site's login (user defaults to chatbot). Without
                         CHAT_PASS, start asks for it when run in a terminal;
                         CHAT_PASS= (set but empty) means the site has no gate
  PORT                   DevTools port, default 9222
  STATE                  where the profile, log and login live, default ~/.chattorrent-peer
                         (not sent to a remote machine, which uses its own default)
  URL, INVITE            the page or invite link to open, which stops remote
                         from asking for one. Default $URL_DEFAULT
  GB                     how much GPU memory answer lends; default is the
                         slider's top stop. GB=0 joins without lending
  ANSWER                 ANSWER=0: remote leaves the welcome popup unanswered
  ANSWER_TIMEOUT         how long answer waits for the popup, default 300s

  CHAT_PASS=secret ./setup-gpu-peer.sh start      # non-interactive
EOF
}

SUDO=
[ "$(id -u)" -eq 0 ] || SUDO=sudo

chrome_bin() {
    command -v google-chrome || command -v google-chrome-stable || true
}

running() {
    [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

install() {
    if ! command -v apt-get > /dev/null; then
        echo "no apt-get here: install google-chrome and the Vulkan loader by hand" >&2
        exit 1
    fi
    $SUDO apt-get update -q
    $SUDO apt-get install -yq wget ca-certificates libvulkan1 vulkan-tools python3
    if [ -z "$(chrome_bin)" ]; then
        local deb
        deb=$(mktemp --suffix=.deb)
        wget -qO "$deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
        $SUDO apt-get install -yq "$deb"
        rm -f "$deb"
    fi

    # Rented containers often have the NVIDIA driver's GL/Vulkan library but no
    # ICD file pointing at it. The Vulkan loader then does not find the GPU and
    # Chrome falls back to SwiftShader, a slow CPU rasterizer.
    local icds=(/usr/share/vulkan/icd.d/nvidia_icd.json /etc/vulkan/icd.d/nvidia_icd.json)
    if [ ! -e "${icds[0]}" ] && [ ! -e "${icds[1]}" ] \
        && ldconfig -p | grep -q libGLX_nvidia.so.0; then
        $SUDO mkdir -p /etc/vulkan/icd.d
        echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}' \
            | $SUDO tee /etc/vulkan/icd.d/nvidia_icd.json > /dev/null
        echo "wrote /etc/vulkan/icd.d/nvidia_icd.json"
    fi

    echo
    "$(chrome_bin)" --version
    check_vulkan
}

check_vulkan() {
    if ! command -v vulkaninfo > /dev/null; then return; fi
    local gpus
    gpus=$(vulkaninfo --summary 2>/dev/null | grep -i 'deviceName' || true)
    echo "Vulkan devices:"
    echo "${gpus:-  (none)}"
    if [ -z "$gpus" ] || ! grep -qiv 'llvmpipe\|swiftshader' <<< "$gpus"; then
        echo "WARNING: no hardware Vulkan device. Chrome will fall back to a CPU renderer." >&2
        echo "  On a container, the host must expose the NVIDIA 'graphics' capability" >&2
        echo "  (NVIDIA_DRIVER_CAPABILITIES=all), not only 'compute,utility'." >&2
    fi
}

# Percent-encode a string for the userinfo part of a URL, so a password
# containing : @ / # or spaces is preserved.
urlencode() {
    local s=$1 out= c i
    for ((i = 0; i < ${#s}; i++)); do
        c=${s:i:1}
        case $c in
            [a-zA-Z0-9.~_-]) out+=$c ;;
            *) printf -v c '%%%02X' "'$c"; out+=$c ;;
        esac
    done
    printf '%s' "$out"
}

# The login: from the environment, then the saved file, then a prompt. Sets
# LOGIN_USER / LOGIN_PASS. An empty LOGIN_PASS means no basic auth.
login() {
    LOGIN_USER=${CHAT_USER:-chatbot}
    if [ -n "${CHAT_PASS+set}" ]; then
        LOGIN_PASS=$CHAT_PASS
    elif [ -f "$AUTHFILE" ]; then
        { IFS= read -r LOGIN_USER; IFS= read -r LOGIN_PASS; } < "$AUTHFILE"
        LOGIN_USER=${CHAT_USER:-$LOGIN_USER}
        return
    elif [ -t 0 ]; then
        IFS= read -rsp "Password for $LOGIN_USER (Enter if the site has no gate): " LOGIN_PASS
        echo
    else
        LOGIN_PASS=
    fi
    if [ -n "$LOGIN_PASS" ]; then
        (umask 077; printf '%s\n%s\n' "$LOGIN_USER" "$LOGIN_PASS" > "$AUTHFILE")
    fi
}

# A peer needs ?direct=1, and an invite link carries its cluster in the
# fragment and nothing in the query (web/room.js inviteUrl), so the flag goes
# in front of the fragment rather than at the end. Already-flagged URLs and
# other query strings are left alone.
normalize_url() {
    local u=$1 frag= query=
    case $u in *'#'*) frag=${u#*\#}; u=${u%%\#*} ;; esac
    case $u in *'?'*) query=${u#*\?}; u=${u%%\?*} ;; esac
    case "&$query&" in
        *'&direct=1&'*) ;;
        *) query=${query:+$query&}direct=1 ;;
    esac
    printf '%s?%s%s' "$u" "$query" "${frag:+#$frag}"
}

# Which cluster this says, for a line to read back: the secret is the user's
# to paste, but it does not need splashing in full across a terminal or a log.
url_summary() {
    local frag=$1 secret model=
    case $1 in *'#mesh='*) frag=${1#*#} ;; *) printf 'the global mesh'; return ;; esac
    secret=${frag#mesh=}; secret=${secret%%&*}
    case $frag in *'&model='*) model=${frag#*&model=}; model=${model%%&*} ;; esac
    printf 'the private cluster %s…%s' "${secret:0:4}" "${model:+ (model $model)}"
}

# The page to open: the argument, then $URL, then the cluster the last start
# was given, then the global mesh. The resolved URL is saved so restart and
# reboot stay on the same cluster, mode 600 because an invite link is a key to
# a private one.
resolve_url() {
    local u=${1:-${URL:-}}
    if [ -n "$u" ]; then
        u=$(normalize_url "$u")
        (umask 077; printf '%s\n' "$u" > "$URLFILE")
    elif [ -s "$URLFILE" ]; then
        IFS= read -r u < "$URLFILE"
    else
        u=$(normalize_url "$URL_DEFAULT")
    fi
    printf '%s' "$u"
}

# DevTools' HTTP endpoints: list the open tabs' ids, and open a tab on a URL,
# printing its id. The URL goes in the query, percent-encoded whole, so a
# #fragment is preserved.
tab_ids() {
    curl -fs "http://127.0.0.1:$PORT/json/list" | grep -o '"id": *"[^"]*"' | cut -d'"' -f4
}
open_tab() {
    curl -fs -X PUT "http://127.0.0.1:$PORT/json/new?$(urlencode "$1")" \
        | grep -o '"id": *"[^"]*"' | cut -d'"' -f4
}

forget() { rm -f "$AUTHFILE" "$URLFILE"; echo "saved login and cluster link deleted"; }

start() {
    local url chrome
    chrome=$(chrome_bin)
    if [ -z "$chrome" ]; then
        echo "google-chrome not found: run ./setup-gpu-peer.sh install first" >&2
        exit 1
    fi
    if running; then
        echo "already running (pid $(cat "$PIDFILE")); run ./setup-gpu-peer.sh restart to relaunch" >&2
        exit 1
    fi
    mkdir -p "$PROFILE"
    chmod 700 "$STATE"
    login
    url=$(resolve_url "${1:-}")
    echo "joining $(url_summary "$url")"

    # Headless WebGPU on Linux: Vulkan through ANGLE, GPU sandbox off. The
    # three background flags stop Chrome throttling a tab that is not visible,
    # which would make a peer waiting on a job look hung. mDNS candidates do
    # not resolve reliably on rented hosts, so real addresses are used.
    # --no-sandbox because these machines usually run as root.
    setsid "$chrome" \
        --headless=new \
        --no-sandbox \
        --disable-gpu-sandbox \
        --enable-unsafe-webgpu \
        --enable-features=Vulkan \
        --use-angle=vulkan \
        --ignore-gpu-blocklist \
        --disable-backgrounding-occluded-windows \
        --disable-background-timer-throttling \
        --disable-renderer-backgrounding \
        --disable-features=WebRtcHideLocalIpsWithMdns \
        --no-first-run \
        --no-default-browser-check \
        --remote-debugging-address=127.0.0.1 \
        --remote-debugging-port="$PORT" \
        --user-data-dir="$PROFILE" \
        --enable-logging=stderr --v=0 \
        about:blank \
        > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"

    # Chrome is up once the DevTools endpoint answers.
    for _ in $(seq 30); do
        if curl -fs "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then break; fi
        if ! running; then
            echo "Chrome exited at startup. Last lines of $LOG:" >&2
            tail -20 "$LOG" >&2
            exit 1
        fi
        sleep 1
    done

    # The page is opened through DevTools, not on the command line, so the
    # login is not in Chrome's argv, where `ps` would show it. The login uses a
    # temporary tab on the site's root: Chrome answers the basic-auth challenge
    # from the URL's userinfo and caches it for the origin. The peer page is
    # then opened without userinfo, because a page whose URL has credentials
    # cannot fetch() relative URLs. Every request it makes (scripts, fetches,
    # the signaling WebSocket) uses the cached login.
    local blank login_tab=
    blank=$(tab_ids | head -1)
    if [ -n "$LOGIN_PASS" ]; then
        local scheme=${url%%://*} host=${url#*://}
        host=${host%%[/?#]*}
        login_tab=$(open_tab "$scheme://$(urlencode "$LOGIN_USER"):$(urlencode "$LOGIN_PASS")@$host/")
        sleep 3
    fi
    open_tab "$url" > /dev/null
    for id in $blank $login_tab; do
        curl -fs "http://127.0.0.1:$PORT/json/close/$id" > /dev/null || true
    done

    if [ -n "${REMOTE_DRIVEN:-}" ]; then
        echo "Chrome is running (pid $(cat "$PIDFILE")) on $url"
        return
    fi

    local host
    host=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo '<this machine>')
    cat <<EOF
Chrome is running (pid $(cat "$PIDFILE")) on $url
It is waiting on the welcome popup. Answer it here:

  ./setup-gpu-peer.sh answer           lend as much as the slider allows
  GB=16 ./setup-gpu-peer.sh answer      lend that much
  ./setup-gpu-peer.sh status            which GPU the page got

or from your own machine, by hand, through a tunnel to the DevTools port:

  ssh -L $PORT:localhost:$PORT <you>@$host     (add -p <port> if your provider gives one)
  local Chrome → chrome://inspect → Configure… → add localhost:$PORT → inspect
EOF
}

stop() {
    if ! running; then echo "not running"; rm -f "$PIDFILE"; return; fi
    local pid
    pid=$(cat "$PIDFILE")
    # setsid made Chrome a process-group leader, so one signal reaches every child.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    for _ in $(seq 10); do running || break; sleep 1; done
    running && kill -KILL -- "-$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "stopped"
}

status() {
    if running; then echo "running (pid $(cat "$PIDFILE")), DevTools on localhost:$PORT"
    else echo "not running"; return; fi
    # peer.js logs the adapter once the GPU is opened, which is after the answer.
    local adapter
    adapter=$(grep -o 'WebGPU adapter: [^"]*' "$LOG" | tail -1 || true)
    if [ -z "$adapter" ]; then
        echo "no GPU opened yet: the welcome popup is probably still unanswered"
    else
        echo "$adapter"
        if grep -qi 'swiftshader\|llvmpipe' <<< "$adapter"; then
            echo "WARNING: that is a CPU renderer, not the GPU. See ./setup-gpu-peer.sh install" >&2
        fi
    fi
}

logs() {
    # Chrome logs a lot. Only the page's console lines are shown.
    tail -n +1 -F "$LOG" | grep --line-buffered 'CONSOLE'
}

# ---------------------------------------------------------------- answer ----
#
# Press the welcome popup's button over the DevTools protocol, so a rented
# machine needs no tunnel and no clicking. DevTools' HTTP endpoints cannot
# evaluate anything (they only list, open and close tabs), so this talks the
# protocol itself over the WebSocket the endpoint names, which is why python3
# is here: the handshake and a masked frame are a page of stdlib, and a
# headless box has no node.
#
# It drives the page the way a person would -- the slider's own keydown
# handler, then a click on the button -- rather than writing the answer into
# localStorage behind the page's back, so whatever the popup does on Join
# (saving the choice, marking the cluster joined, resolving the promise peer.js
# waits on) happens exactly once and in the right order.

answer() {
    if ! running; then
        echo "not running: ./setup-gpu-peer.sh start first" >&2
        exit 1
    fi
    if ! command -v python3 > /dev/null; then
        echo "python3 is needed to drive DevTools, and this machine has none:" >&2
        echo "  apt-get install -yq python3" >&2
        echo "or answer the popup by hand (./setup-gpu-peer.sh help, \"tunnel\")" >&2
        exit 1
    fi

    # Pressing Join in the page is the visitor's agreement to the terms, so
    # pressing it from here says the same thing on behalf of whoever ran this.
    cat <<'EOF'
Answering the welcome popup for you. As in the page, this confirms you are 18
or over and accept the code of conduct, terms of service and privacy policy.
EOF
    local url
    url=$(resolve_url "")
    python3 - "$PORT" "${GB:-max}" "${url%%#*}" "${ANSWER_TIMEOUT:-300}" <<'PY' || return 1
import base64, json, os, socket, struct, sys, time, urllib.request

port, want_arg, base, timeout = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
want = -1 if want_arg in ('max', '') else int(want_arg)

# The serving tab, among the targets the DevTools endpoint lists. The tab this
# script opened is the only http page in the profile, but it is matched on the
# URL anyway, so a stray tab cannot be driven by mistake.
def page():
    with urllib.request.urlopen('http://127.0.0.1:%s/json/list' % port, timeout=10) as r:
        targets = json.load(r)
    pages = [t for t in targets
             if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
    for t in pages:
        if base and t.get('url', '').startswith(base):
            return t
    for t in pages:
        if t.get('url', '').startswith('http'):
            return t
    return None

# Enough of RFC 6455 to talk to a loopback DevTools: no TLS, no extensions, no
# fragments going out. Incoming messages are large (a page of JSON) and can
# arrive in continuation frames, so those are joined.
class Ws:
    def __init__(self, url):
        hostport, _, path = url[len('ws://'):].partition('/')
        host, _, p = hostport.partition(':')
        self.sock = socket.create_connection((host, int(p or 80)), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            'GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n'
            'Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n'
            'Sec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, key)).encode())
        self.buf = b''
        while b'\r\n\r\n' not in self.buf:
            self._fill()
        head, _, self.buf = self.buf.partition(b'\r\n\r\n')
        status = head.split(b'\r\n')[0].decode('latin-1')
        if ' 101' not in status:
            die('DevTools refused the WebSocket: %s' % status)

    def _fill(self):
        chunk = self.sock.recv(1 << 16)
        if not chunk:
            die('DevTools closed the connection')
        self.buf += chunk

    def _take(self, n):
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _frame(self, opcode, payload):
        head = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head.append(0x80 | n)
        elif n < (1 << 16):
            head.append(0x80 | 126)
            head += struct.pack('>H', n)
        else:
            head.append(0x80 | 127)
            head += struct.pack('>Q', n)
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send(self, obj):
        self._frame(0x1, json.dumps(obj).encode())

    def recv(self):
        data = b''
        while True:
            b0, b1 = self._take(2)
            fin, opcode, n = b0 & 0x80, b0 & 0x0f, b1 & 0x7f
            if n == 126:
                n = struct.unpack('>H', self._take(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._take(8))[0]
            payload = self._take(n) if n else b''
            if opcode == 0x8:
                die('DevTools closed the WebSocket')
            if opcode == 0x9:          # ping: keep the connection alive
                self._frame(0xa, payload)
                continue
            if opcode == 0xa:          # pong
                continue
            data += payload
            if fin:
                return json.loads(data.decode())

def die(msg):
    print(msg, file=sys.stderr)
    raise SystemExit(1)

seq = 0

def evaluate(ws, expression):
    global seq
    seq += 1
    ws.send({'id': seq, 'method': 'Runtime.evaluate',
             'params': {'expression': expression, 'returnByValue': True,
                        'awaitPromise': True}})
    while True:
        msg = ws.recv()                # events arrive in between; ignore them
        if msg.get('id') != seq:
            continue
        if 'error' in msg:
            die('DevTools error: %s' % msg['error'].get('message', msg['error']))
        result = msg.get('result', {})
        if 'exceptionDetails' in result:
            text = result['exceptionDetails'].get('exception', {}).get('description', '')
            die('the page threw: %s' % (text or json.dumps(result['exceptionDetails']))[:400])
        return result.get('result', {}).get('value')

# Read the popup, and on the acting pass set the amount and press Join in the
# same round trip, so the page cannot change between the reading and the
# pressing.
#
# The amount is set through the slider's own keydown handler (web/lend.js), the
# path the arrow keys take, and read back from aria-valuenow, which that
# handler maintains. A locked slider ignores every key, which is how a machine
# with no usable GPU reports itself here.
JS = r"""
((act) => {
  const dlg = document.getElementById('welcome');
  const handle = document.getElementById('lendHandle');
  const go = document.getElementById('welcomeYes');
  if (!dlg || !handle || !go) return { state: 'loading' };
  // web/welcome.js's KEY, read to tell "not shown yet" from "already done".
  let saved = false;
  try { saved = !!JSON.parse(localStorage.getItem('chattorrent.welcome.v1'))?.agreed; }
  catch { /* no answer kept */ }
  if (!dlg.open) return { state: saved ? 'answered' : 'loading' };

  const locked = handle.getAttribute('aria-disabled') === 'true';
  if (!act) {
    return { state: 'ready', locked, disabled: !!go.disabled,
             why: (go.textContent ?? '').trim(),
             line: (document.getElementById('lendOut')?.textContent ?? '').trim() };
  }

  const at = () => Number(handle.getAttribute('aria-valuenow')) || 0;
  const max = Number(handle.getAttribute('aria-valuemax')) || 0;
  const want = __WANT__ < 0 ? max : Math.min(__WANT__, max);
  const key = (k) => handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  key('End');                                   // the top stop, then step down
  let guard = 2 * max + 8;
  while (at() > want && guard-- > 0) key('ArrowLeft');
  while (at() < want && guard-- > 0) key('ArrowRight');
  const gb = at();
  if (locked) {
    return { state: 'cannot-lend', locked: true, gb, max,
             line: (document.getElementById('lendOut')?.textContent ?? '').trim() };
  }
  if (want > 0 && gb === 0) return { state: 'cannot-lend', locked: false, gb, max };
  if (go.disabled) {
    return { state: 'blocked', gb, max, why: (go.textContent ?? '').trim() };
  }
  go.click();
  return { state: 'joined', gb, max, open: dlg.open };
})(__ACT__)
""".replace('__WANT__', str(want))

def js(act):
    return JS.replace('__ACT__', 'true' if act else 'false')

def cannot_lend(r):
    if r.get('locked'):
        die('the page has locked the lend slider%s: this browser cannot lend its\n'
            'GPU, so it would join as a visitor. That is the no-WebGPU or software\n'
            'renderer case: ./setup-gpu-peer.sh install'
            % (' ("%s")' % r['line'] if r.get('line') else ''))
    die('the lend slider would not leave zero, with a top stop of %s GB: nothing\n'
        'would be lent, so the answer is left to you' % r.get('max'))

target = page()
if target is None:
    die('no page open on %s: is the tab still there? ./setup-gpu-peer.sh status' % base)
ws = Ws(target['webSocketDebuggerUrl'])

# The popup appears once the page's scripts have run, which on a cold cache is
# a few seconds, and the Join button stays disabled while the public demo is
# full, so both are waited out rather than failed on.
#
# The popup is read before it is answered, and the answer waits SETTLE after it
# first looks ready: welcome.js locks the slider from an adapter request that
# resolves a moment after the popup is shown, so pressing Join the instant it
# appears could agree to lend on a machine that has just discovered it cannot.
SETTLE = 2.0
deadline = time.time() + timeout
said = None
ready_at = None

def waiting(what):
    global said
    if what != said:
        said = what
        print('waiting: %s' % what)

while True:
    probe = evaluate(ws, js(False)) or {'state': 'loading'}
    state = probe.get('state')

    if state == 'answered':
        print('the popup was already answered')
        break

    if state == 'ready':
        if probe.get('locked'):
            cannot_lend(probe)
        if probe.get('disabled'):
            waiting('the cluster is full ("%s")' % probe.get('why', ''))
        elif ready_at is None:
            ready_at = time.time() + SETTLE      # let canLend() have its say
        elif time.time() >= ready_at:
            r = evaluate(ws, js(True)) or {'state': 'loading'}
            if r.get('state') == 'cannot-lend':
                cannot_lend(r)
            if r.get('state') == 'joined':
                gb = r.get('gb')
                print('pressed Join, lending %s' % ('%d GB' % gb if gb else 'nothing'))
                if r.get('open'):
                    die('the popup did not close: the page did not take the click')
                break
            # Blocked between the reading and the pressing: go round again.
            waiting('the cluster is full ("%s")' % r.get('why', ''))
    else:
        waiting('the page is still loading')

    if time.time() >= deadline:
        if state == 'ready':
            die('the cluster is full and Join stayed disabled ("%s") for %ds'
                % (probe.get('why', ''), timeout))
        die('the welcome popup never opened in %ds: see ./setup-gpu-peer.sh logs' % timeout)
    time.sleep(1)
PY

    # The GPU is opened right after the answer, and the adapter it got is the
    # thing worth seeing: a CPU renderer here means the rest is pointless.
    local adapter=
    for _ in $(seq 30); do
        adapter=$(grep -o 'WebGPU adapter: [^"]*' "$LOG" | tail -1 || true)
        [ -n "$adapter" ] && break
        sleep 1
    done
    if [ -z "$adapter" ]; then
        echo "no GPU opened yet; ./setup-gpu-peer.sh status in a moment, or logs" >&2
        return 0
    fi
    echo "$adapter"
    if grep -qi 'swiftshader\|llvmpipe' <<< "$adapter"; then
        echo "WARNING: that is a CPU renderer, not the GPU. See ./setup-gpu-peer.sh install" >&2
        return 1
    fi
}

# ---------------------------------------------------------------- remote ----
#
# Everything below runs on your own machine and drives a rented one. It takes
# the ssh command the provider gave you, as-is.

# A leading ~/ in a path, expanded. The shell does this for an unquoted ssh
# command, but not for one passed as a single quoted string, and ssh does not
# do it either: it would look for a directory literally named "~" and then fall
# back to the agent, which answers "Permission denied (publickey)" and says
# nothing about the key that was asked for.
expand_tilde() {
    case $1 in
        '~/'*) printf '%s/%s' "$HOME" "${1#'~/'}" ;;
        *) printf '%s' "$1" ;;
    esac
}

# Split an ssh command line into what it takes to reach the machine: SSH_DEST,
# SSH_PORT and SSH_OPTS, the last holding only options scp and ssh both accept,
# so one parse serves both. Anything that shapes the session rather than the
# connection is dropped and named on stderr, because this script opens its own
# connections: a -L the provider suggested would collide with our own tunnel,
# and a -N would leave no shell to run anything in.
parse_ssh() {
    SSH_DEST= SSH_PORT= SSH_KEY= SSH_OPTS=()
    local args=("$@") user= dropped=() i=0 a v
    # Accept the whole command as one quoted argument too.
    if [ ${#args[@]} -eq 1 ]; then read -ra args <<< "${args[0]}"; fi
    [ "${args[0]:-}" = ssh ] && args=("${args[@]:1}")

    while [ $i -lt ${#args[@]} ]; do
        a=${args[i]}
        case $a in
            -p)  SSH_PORT=${args[i+1]:-}; i=$((i + 2)) ;;
            -p*) SSH_PORT=${a#-p}; i=$((i + 1)) ;;
            -l)  user=${args[i+1]:-}; i=$((i + 2)) ;;
            -l*) user=${a#-l}; i=$((i + 1)) ;;
            # A key or a config file: a path, so it may need the tilde.
            -i|-F)
                v=$(expand_tilde "${args[i+1]:-}")
                [ "$a" = -i ] && SSH_KEY=$v
                SSH_OPTS+=("$a" "$v"); i=$((i + 2)) ;;
            -i*|-F*)
                v=$(expand_tilde "${a:2}")
                [ "${a:0:2}" = -i ] && SSH_KEY=$v
                SSH_OPTS+=("${a:0:2}" "$v"); i=$((i + 1)) ;;
            # Other connection options scp understands as well, with their value.
            -o|-J|-c)
                SSH_OPTS+=("$a" "${args[i+1]:-}"); i=$((i + 2)) ;;
            -o*|-J*|-c*)
                SSH_OPTS+=("${a:0:2}" "${a:2}"); i=$((i + 1)) ;;
            -4|-6|-C)
                SSH_OPTS+=("$a"); i=$((i + 1)) ;;
            # Session options, dropped with their value.
            -L|-R|-D|-W|-S|-O|-Q|-e|-m|-E|-w|-b|-B|-I)
                dropped+=("$a ${args[i+1]:-}"); i=$((i + 2)) ;;
            -L*|-R*|-D*|-W*)
                dropped+=("$a"); i=$((i + 1)) ;;
            # Session flags, dropped.
            -N|-T|-t|-f|-n|-q|-g|-K|-M|-s|-y|-A|-a|-k|-x|-X|-Y|-G|-V|-v|-vv|-vvv)
                dropped+=("$a"); i=$((i + 1)) ;;
            -*)  dropped+=("$a"); i=$((i + 1)) ;;
            *)
                if [ -z "$SSH_DEST" ]; then SSH_DEST=$a
                else dropped+=("$a")   # a remote command; we supply our own
                fi
                i=$((i + 1)) ;;
        esac
    done

    if [ -z "$SSH_DEST" ]; then
        echo "no machine in that ssh command: expected something like root@1.2.3.4" >&2
        return 1
    fi
    if [ "$SSH_DEST" != "${SSH_DEST#ssh://}" ]; then
        # ssh://user@host:port carries the port in the destination instead.
        SSH_DEST=${SSH_DEST#ssh://}
        case $SSH_DEST in
            *:[0-9]*) SSH_PORT=${SSH_PORT:-${SSH_DEST##*:}}; SSH_DEST=${SSH_DEST%:*} ;;
        esac
    fi
    [ -n "$user" ] && SSH_DEST=${user}@${SSH_DEST#*@}

    # Always say what was understood, so a refused login can be read off this
    # line rather than guessed at.
    echo "reaching ${SSH_DEST}${SSH_PORT:+ on port $SSH_PORT}${SSH_KEY:+ with key $SSH_KEY}${dropped[*]:+, ignoring: ${dropped[*]}}" >&2
    if [ -n "$SSH_KEY" ] && [ ! -r "$SSH_KEY" ]; then
        echo "  WARNING: no readable key file there, so ssh will try the agent instead" >&2
    fi
}

# One command there. -n because ssh otherwise hands the remote command this
# script's own stdin, and several in a row would race for the terminal's input
# (or hang on a pipe that never closes); rsh_in is for the one that needs it.
# ${a[@]:+...} because an empty SSH_OPTS is the common case and set -u rejects
# a bare expansion of an empty array on older bash.
rsh() {
    ssh -n ${SSH_OPTS[@]:+"${SSH_OPTS[@]}"} ${SSH_PORT:+-p "$SSH_PORT"} "$SSH_DEST" "$@"
}
rsh_in() {
    ssh ${SSH_OPTS[@]:+"${SSH_OPTS[@]}"} ${SSH_PORT:+-p "$SSH_PORT"} "$SSH_DEST" "$@"
}

# Copy this very file over, whatever name or directory it was run from.
push() {
    local self
    self=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
    scp -q ${SSH_OPTS[@]:+"${SSH_OPTS[@]}"} ${SSH_PORT:+-P "$SSH_PORT"} \
        "$self" "$SSH_DEST:setup-gpu-peer.sh" || return 1
    rsh 'chmod +x ~/setup-gpu-peer.sh'
}

# Hand the login to the remote copy by writing its auth file over the ssh pipe,
# so the password is in neither machine's argv (where ps would show it) and
# restarts there need nothing. An empty password means the site has no gate,
# which is said with CHAT_PASS= rather than by leaving a stale file to be read.
push_login() {
    login
    if [ -n "$LOGIN_PASS" ]; then
        printf '%s\n%s\n' "$LOGIN_USER" "$LOGIN_PASS" \
            | rsh_in 'mkdir -p ~/.chattorrent-peer && chmod 700 ~/.chattorrent-peer && umask 077 && cat > ~/.chattorrent-peer/auth' \
            || return 1
        REMOTE_ENV="PORT=$PORT"
    else
        REMOTE_ENV="PORT=$PORT CHAT_PASS="
    fi
}

# The cluster, handed over the way the login is: an invite link is a key to a
# private mesh, so it stays out of a command line on both machines. The remote
# start reads it from that file, which also keeps a restart or a reboot on the
# same cluster. Written even for the global mesh, so a machine moved back to it
# does not quietly rejoin yesterday's private cluster from its saved file.
push_url() {
    printf '%s\n' "$PEER_URL" \
        | rsh_in 'mkdir -p ~/.chattorrent-peer && chmod 700 ~/.chattorrent-peer && umask 077 && cat > ~/.chattorrent-peer/url'
}

# The cluster all these peers should join: an invite link pasted at the prompt,
# or Enter for the global mesh. $INVITE or $URL answers it without asking, and
# so does a run with no terminal. Asked once, before any machine is touched,
# because rented GPUs are rented to serve the same cluster.
ask_invite() {
    local v=${INVITE:-${URL:-}}
    if [ -z "$v" ] && [ -t 0 ]; then
        while true; do
            IFS= read -rp 'Paste the cluster invite link (Enter for the global mesh): ' v || v=
            [ -z "$v" ] && break
            case $v in
                *'#mesh='*) break ;;
                *) echo "  not an invite link: it should carry a #mesh=… fragment, as the" >&2
                   echo "  Invite button copies it. Enter alone is the global mesh." >&2
                   v= ;;
            esac
        done
    fi
    PEER_URL=$(normalize_url "${v:-$URL_DEFAULT}")
    echo "peers will join $(url_summary "$PEER_URL")"
}

# The machines to act on, read from a file of ssh commands as the provider gave
# them, one per line. A line ending in ":" labels the lines under it, which is
# how such a list is usually kept:
#
#   RTX 5060:
#   ssh -p 24067 root@1.2.3.4 -L 8080:localhost:8080
#   ssh -p 15810 root@5.6.7.8
#
# Blank lines and # comments are skipped. A line is split on whitespace, so an
# option whose value holds a space has to be written as one word
# (-oProxyCommand=…).
read_machines() {
    MACHINES=() LABELS=()
    local line label=
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line#"${line%%[![:space:]]*}"}
        line=${line%"${line##*[![:space:]]}"}
        case $line in
            '' | '#'*) continue ;;
            *:) label=${line%:}; continue ;;
        esac
        MACHINES+=("$line"); LABELS+=("$label"); label=
    done < "$1"
    if [ ${#MACHINES[@]} -eq 0 ]; then
        echo "no ssh commands in $1" >&2
        return 1
    fi
    echo "${#MACHINES[@]} machine(s) from $1"
}

# The tunnel for one machine, to print for the user to paste. Every machine
# keeps DevTools on $PORT, since each has its own loopback; it is the local end
# that has to differ, so machine n gets $PORT + n here.
tunnel_cmd() {
    printf 'ssh -N -L %s:localhost:%s%s%s %s' "$LOCAL_PORT" "$PORT" \
        "${SSH_PORT:+ -p $SSH_PORT}" "${SSH_OPTS[*]:+ ${SSH_OPTS[*]}}" "$SSH_DEST"
}

# Hold every machine's tunnel open at once, each on its own local port, until
# Ctrl-C. One ssh per machine, backgrounded, with -n so none of them takes the
# terminal's input.
tunnels() {
    local pids=() map=() i
    for i in "${!MACHINES[@]}"; do
        parse_ssh "${MACHINES[i]}" || continue
        LOCAL_PORT=$((PORT + i))
        ssh -n -N -L "$LOCAL_PORT:localhost:$PORT" \
            ${SSH_OPTS[@]:+"${SSH_OPTS[@]}"} ${SSH_PORT:+-p "$SSH_PORT"} "$SSH_DEST" &
        pids+=("$!")
        map+=("  localhost:$LOCAL_PORT  ${LABELS[i]:+${LABELS[i]} · }$SSH_DEST")
    done
    if [ ${#pids[@]} -eq 0 ]; then echo "no machine to tunnel to" >&2; exit 1; fi
    cat <<EOF

Forwarding each machine's DevTools port:

$(printf '%s\n' "${map[@]}")

In your local Chrome open chrome://inspect, click "Configure…", add every
address above, and press "inspect" under the ClusterChat tab listed for each.
That is a real view of the page: the welcome popup if it is still unanswered
(pick an amount and press Join), the chat and the download if it is not.
Ctrl-C here when you are done looking.
EOF
    trap 'kill "${pids[@]}" 2> /dev/null; exit 0' INT TERM
    wait || true
}

# The popup, pressed on the machine itself: DevTools listens on its loopback,
# so this needs no tunnel. GB and ANSWER_TIMEOUT are carried over if they were
# set here, since they are the two things worth varying per run.
remote_answer() {
    rsh "PORT=$PORT ${GB:+GB=$GB }${ANSWER_TIMEOUT:+ANSWER_TIMEOUT=$ANSWER_TIMEOUT }~/setup-gpu-peer.sh answer"
}

# ANSWER=0 leaves the popup to the person, and then the tunnel is the way in.
answer_or_say() {
    if [ "${ANSWER:-1}" = 0 ]; then
        echo "  popup left unanswered (ANSWER=0); tunnel: $(tunnel_cmd)"
        return 0
    fi
    remote_answer
}

# One action on one machine, whose connection parse_ssh has already read.
# Every step ends in `|| return 1`: the caller runs this inside an `if`, which
# suspends errexit, so a failed scp or ssh would otherwise be stepped over and
# the machine counted as done.
run_action() {
    case $1 in
        up)
            push || return 1
            local state
            state=$(rsh "PORT=$PORT ~/setup-gpu-peer.sh status") || return 1
            if [ "${state#running}" != "$state" ]; then
                # Rerunning up on a machine that is already serving reports it
                # rather than failing on start's "already running".
                echo "$state"
                echo "  already serving; ./setup-gpu-peer.sh remote restart … to move it"
                return 0
            fi
            push_login || return 1
            push_url || return 1
            # install is idempotent but spends a minute in apt; skip it once
            # Chrome is there.
            rsh 'command -v google-chrome > /dev/null 2>&1 || ~/setup-gpu-peer.sh install' || return 1
            rsh "REMOTE_DRIVEN=1 $REMOTE_ENV ~/setup-gpu-peer.sh start" || return 1
            answer_or_say || return 1
            ;;
        start | restart)
            push || return 1
            push_login || return 1
            push_url || return 1
            rsh "REMOTE_DRIVEN=1 $REMOTE_ENV ~/setup-gpu-peer.sh $1" || return 1
            answer_or_say || return 1
            ;;
        answer)
            remote_answer || return 1
            ;;
        install)
            push || return 1
            rsh '~/setup-gpu-peer.sh install' || return 1
            ;;
        logs)
            # logs tails; give it a tty so Ctrl-C reaches it.
            ssh -t ${SSH_OPTS[@]:+"${SSH_OPTS[@]}"} ${SSH_PORT:+-p "$SSH_PORT"} \
                "$SSH_DEST" "PORT=$PORT ~/setup-gpu-peer.sh logs"
            ;;
        *)
            rsh "PORT=$PORT ~/setup-gpu-peer.sh $1"
            ;;
    esac
}

remote() {
    local action=up
    case "${1:-}" in
        up|install|start|restart|stop|status|answer|logs|forget|tunnel) action=$1; shift ;;
    esac
    if [ $# -eq 0 ]; then
        echo "remote needs the ssh command for the machine, or a file of them:" >&2
        echo "  ./setup-gpu-peer.sh remote ssh -p 55665 root@1.2.3.4" >&2
        echo "  ./setup-gpu-peer.sh remote gpus.txt" >&2
        exit 1
    fi

    # What to repeat in the lines this prints afterwards: the file, or the ssh
    # command as it was given.
    local spec="$*"

    # One ssh command, or a file holding several.
    if [ $# -eq 1 ] && [ -f "$1" ]; then
        read_machines "$1" || exit 1
    else
        MACHINES=("$*") LABELS=("")
    fi
    if [ ${#MACHINES[@]} -gt 1 ] && [ "$action" = logs ]; then
        echo "logs follows one machine: give it that machine's ssh command" >&2
        exit 1
    fi

    # The cluster is asked for before anything is touched, so a wrong paste
    # costs nothing, and every machine in the file gets the same answer.
    case $action in up | start | restart) ask_invite ;; esac
    if [ "$action" = tunnel ]; then tunnels; return; fi

    local i ok=0 failed=()
    for i in "${!MACHINES[@]}"; do
        LOCAL_PORT=$((PORT + i))
        if [ ${#MACHINES[@]} -gt 1 ]; then
            printf '\n── %smachine %d of %d ──\n' \
                "${LABELS[i]:+${LABELS[i]} · }" "$((i + 1))" "${#MACHINES[@]}"
        fi
        # A dead or mistyped machine must not stop the rest of the list.
        if parse_ssh "${MACHINES[i]}" && run_action "$action"; then
            ok=$((ok + 1)); continue
        fi
        failed+=("${SSH_DEST:-${MACHINES[i]}}")
    done

    if [ $ok -gt 0 ] && { [ "$action" = up ] || [ "$action" = start ] || [ "$action" = restart ]; }; then
        cat <<EOF

Downloading their share of the model now, which takes a few minutes:

  ./setup-gpu-peer.sh remote status $spec     which GPU each one got
  ./setup-gpu-peer.sh remote logs <one ssh command>      follow one of them

To look at a page yourself, in Chrome:

  ./setup-gpu-peer.sh remote tunnel $spec
EOF
    fi
    if [ ${#failed[@]} -gt 0 ]; then
        echo >&2
        echo "failed on:" >&2
        printf '  %s\n' "${failed[@]}" >&2
        exit 1
    fi
}

case "${1:-help}" in
    install)  install ;;
    start)    start "${2:-}" ;;
    stop)     stop ;;
    restart)  stop; start "${2:-}" ;;
    status)   status ;;
    answer)   answer ;;
    logs)     logs ;;
    forget)   forget ;;
    remote)   shift; remote "$@" ;;
    help|-h|--help) usage ;;
    *)        usage; exit 1 ;;
esac
