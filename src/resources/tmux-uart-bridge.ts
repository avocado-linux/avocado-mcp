export const URI = "avocado://skills/tmux-uart-bridge";
export const NAME = "tmux-uart-bridge";
export const DESCRIPTION =
  "The canonical pattern for letting Claude drive a UART serial console: a tmux session running a serial terminal emulator (`tio`, `picocom`, or `minicom`) that Claude controls via `tmux send-keys` and `tmux capture-pane`. **Two prerequisites:** tmux AND an emulator — tmux alone cannot talk to a serial device. Read this before invoking get-tmux-uart-snippet or trying to debug a device over UART.";

export const CONTENT = `# Driving a UART console through tmux

## Two prerequisites — both required

\`tmux\` is a session multiplexer. **It does NOT speak to serial devices.** You also need a serial terminal emulator that opens the port and handles the line discipline. The whole stack:

| Layer | Tool | Role |
|-------|------|------|
| Outer | \`tmux\` | Detachable, scriptable session Claude can \`send-keys\` to and \`capture-pane\` from |
| Inner | \`tio\` / \`picocom\` / \`minicom\` | Actually opens \`/dev/tty*\`, talks to the UART |

Without an emulator, \`tmux new-session -d -s avocado-uart\` just gives you an empty shell — no serial console.

## Picking an emulator

Use the first one already installed on the host (per \`detect-serial-ports\`). If none are installed, recommend \`tio\` — it has the cleanest output for \`tmux capture-pane\`.

| Emulator | Install | Notes |
|----------|---------|-------|
| \`tio\` (preferred) | macOS: \`brew install tio\` • Debian/Ubuntu: \`sudo apt install tio\` | Modern, scriptable, no funky terminal control sequences. Best fit for \`capture-pane\`. |
| \`picocom\` | macOS: \`brew install picocom\` • Debian/Ubuntu: \`sudo apt install picocom\` | Very common on Linux; works fine inside tmux. Exit via Ctrl-A Ctrl-X (irrelevant in our flow — we tear the session down with \`tmux kill-session\`). |
| \`minicom\` | macOS: \`brew install minicom\` • Debian/Ubuntu: \`sudo apt install minicom\` | Heavyweight, menu-driven, but works. Always pass \`-o\` to skip its modem init string, otherwise it sends AT commands to your target on startup. |

### Why not \`screen\`?

\`screen /dev/ttyUSB0 115200\` does open the port and you *can* type into it. But under tmux automation it's the wrong tool:

- **Ctrl-A binding conflict.** \`screen\`'s prefix is Ctrl-A; if the user has remapped \`tmux\` from Ctrl-B to Ctrl-A (common), keystrokes Claude sends collide.
- **Terminal control sequences** (line drawing, status bar) pollute \`capture-pane\` output — you get escape junk mixed with the device's actual stdout.
- **Awkward teardown.** \`Ctrl-A k\` then \`y\` to exit, vs. our flow which just \`tmux kill-session\`s.

Install one of \`tio\` / \`picocom\` / \`minicom\` instead.

## The interaction model

Claude's Bash tool runs commands that return and exit — it can't sit inside an interactive emulator session and type. The pattern:

1. **The user starts a detached tmux session** with the emulator running inside, attached to the serial port.
2. **Claude sends commands** with \`tmux send-keys -t <session> '<cmd>' Enter\`.
3. **Claude reads output** with \`tmux capture-pane -t <session> -p -S -<lines>\`.

Both \`send-keys\` and \`capture-pane\` are one-shot and stateless — perfect for the Bash tool.

## Setup (run once per device session)

\`\`\`bash
# Replace /dev/tty.usbserial-XXX with the actual port from detect-serial-ports.
# Use whichever emulator detect-serial-ports reports as installed.
tmux new-session -d -s avocado-uart 'tio -b 115200 /dev/tty.usbserial-XXX'
# or: 'picocom -b 115200 /dev/tty.usbserial-XXX'
# or: 'minicom -b 115200 -D /dev/tty.usbserial-XXX -o'
\`\`\`

\`-d\` starts the session detached. The user can attach in another terminal with \`tmux attach -t avocado-uart\` to watch what Claude is doing.

## First capture: log in if you see a login prompt

The very first thing to do after \`tmux new-session\` is **capture the pane** and look at what's actually on the console before sending diagnostic commands:

\`\`\`bash
sleep 1
tmux capture-pane -t avocado-uart -p -S -50
\`\`\`

Three possibilities:

1. **Login prompt** (e.g. \`avocado-rpi5 login:\`). Send \`root\` and Enter — the \`dev\` runtime ships a passwordless root account:
   \`\`\`bash
   tmux send-keys -t avocado-uart 'root' Enter
   \`\`\`
   No password prompt should follow. If one does, the device is not running the dev runtime; ask the user for credentials.

2. **Already a shell prompt** (\`#\` or \`<hostname>:~#\`). You're in. Tap Enter once to confirm the prompt is responsive:
   \`\`\`bash
   tmux send-keys -t avocado-uart '' Enter
   \`\`\`

3. **No prompt, just boot output or blank.** Wait a few seconds, capture again. If still nothing after ~10s, capture more lines (\`-S -1000\`) and look for kernel panic / mount failures.

**Never send a diagnostic command before confirming you have a shell prompt.** If the console is at \`login:\`, your \`journalctl ...\` command gets typed as the username and is rejected.

## Sending a command

\`\`\`bash
tmux send-keys -t avocado-uart 'journalctl -xeu my-app.service --no-pager | tail -50' Enter
\`\`\`

**Important:** always use \`Enter\` as a separate \`send-keys\` argument (not \`\\n\` inside the string). \`tmux send-keys -t ... 'cmd\\n'\` sends the literal characters \`\\\` and \`n\`, not a newline.

## Token discipline — bound every command you send

UART debugging burns context fast because every line on the console is a token in the next capture. Every command must bound its output:

| Don't | Do | Why |
|---|---|---|
| \`journalctl -xe\` | \`journalctl -xe --no-pager \\| tail -50\` | Unbounded journals are huge |
| \`journalctl -u foo\` | \`journalctl -u foo --no-pager --since '5 min ago' \\| tail -50\` | Time-bound + line-bound |
| \`dmesg\` | \`dmesg --color=never \\| tail -30\` or \`dmesg \\| grep -i error \\| tail -20\` | Boot dmesg is hundreds of lines |
| \`systemctl status foo\` | \`systemctl status foo --no-pager -n 20\` | \`-n 20\` caps the log tail systemctl includes |
| \`cat /var/log/messages\` | \`tail -100 /var/log/messages\` or \`grep -i error /var/log/messages \\| tail -20\` | Files can be megabytes |
| \`ls -R /\` or \`find /\` | \`ls /etc\`, \`find /var/lib/myapp -maxdepth 2\` | Recursive walks of \`/\` are enormous |
| \`top\` / \`htop\` / \`less\` / \`vi\` | \`top -bn1 \\| head -20\`, \`ps -ef \\| grep foo\` | Interactive commands don't return |
| Repeated \`tmux capture-pane -S -5000\` | \`tmux capture-pane -S -200\` first; only widen if you need earlier output | Default to the smallest scrollback window that answers the question |

**Always pipe through \`grep\` once you know what you're looking for.** \`grep -i 'failed\\|error\\|denied'\` beats reading the whole log.

**Always use \`--no-pager\` with systemd tools.** \`journalctl\`, \`systemctl status\`, \`systemctl list-units\` all default to paging when stdout is a tty — over UART they'll stall waiting for spacebar.

**Never use follow mode.** No \`journalctl -f\`, no \`tail -f\`. They don't return; the bridge gets stuck and the only recovery is \`tmux kill-session\`.

## Reading output

\`\`\`bash
# Last 200 lines of the visible buffer
tmux capture-pane -t avocado-uart -p -S -200
\`\`\`

\`-p\` prints to stdout; \`-S -N\` starts at N lines back. Use a generous \`-S\` value because async kernel messages can fill the buffer between your send and your capture.

## Recommended pattern for one command at a time

\`\`\`bash
# 1. Add a sentinel before sending so you can find the start of output
tmux send-keys -t avocado-uart "echo '===SENTINEL_$RANDOM==='" Enter

# 2. Send the actual command
tmux send-keys -t avocado-uart 'journalctl -xeu my-app.service --no-pager | tail -50' Enter

# 3. Wait a beat
sleep 1

# 4. Capture and slice from the sentinel onwards
tmux capture-pane -t avocado-uart -p -S -500
\`\`\`

If you're scripting many commands, generate a unique sentinel per command and grep for it to isolate that command's output.

## Waiting for slow events — \`until\`-loop, NOT \`sleep N\`

Sometimes you need to wait for something that takes time: device boot (15–60 seconds from power-on to login prompt), a service starting after a deploy, a long-running command finishing. **Do NOT use \`sleep 30\` / \`sleep 45\` / \`sleep 60\` to "just wait long enough"** — Claude Code blocks long sleeps and chained shorter sleeps will also be rejected. The replacement is an \`until\`-loop that polls a real condition and exits when the condition is met:

\`\`\`bash
# Wait for a login prompt or shell prompt to appear in the capture, up to ~60s
until tmux capture-pane -t avocado-uart -p -S -50 | grep -qE 'login:|root@|# $|\\$ $'; do sleep 2; done
\`\`\`

\`\`\`bash
# Wait for a specific sentinel to appear after sending a long-running command
tmux send-keys -t avocado-uart "long-command; echo '===DONE_$RANDOM==='" Enter
SENTINEL='===DONE_'   # use the exact $RANDOM value you generated above
until tmux capture-pane -t avocado-uart -p -S -500 | grep -q "$SENTINEL"; do sleep 2; done
tmux capture-pane -t avocado-uart -p -S -500
\`\`\`

\`\`\`bash
# Wait for a systemd unit to become active on the device (poll via UART)
until tmux send-keys -t avocado-uart 'systemctl is-active my-app.service' Enter; \\
      sleep 1; \\
      tmux capture-pane -t avocado-uart -p -S -20 | grep -qE '^active$'; \\
      do sleep 2; done
\`\`\`

Run these via the **Monitor** tool when your host (e.g. Claude Code) exposes it — Monitor watches a streaming command and notifies you when the \`until\`-loop exits, so you don't burn turns polling. If Monitor isn't available, run the loop as a normal Bash command; it will block until the condition is met, then return.

Short \`sleep 1\` or \`sleep 2\` between sending a command and capturing its output is fine — those are synchronization beats, not waits. The rule is: **if you're tempted to write \`sleep 10\` or more, replace it with an \`until\`-loop on a real condition.**

## Gotchas

- **Always use \`--no-pager\` and never use \`-f\` (follow)** with journalctl over this bridge. Paged output stops at "press space" and follow never returns.
- **Don't send Ctrl-C casually.** Use \`tmux send-keys -t avocado-uart C-c\` only when you mean it; on a UART console it kills whatever's running on the device.
- **Boot messages will interleave** with your output if a service crashes mid-command. Capture more lines than you think you need.
- **Watch for the shell prompt** in the captured output (\`#\` for root) to know a command finished. If you don't see a prompt at the end of the capture, wait and capture again.
- **Don't pipe interactive editors.** No \`vi\`, \`nano\`, \`htop\`, \`top\`. Use one-shot equivalents: \`cat\`, \`ps -ef\`, \`top -bn1\`.

## Tearing down

\`\`\`bash
tmux kill-session -t avocado-uart
\`\`\`

This frees the serial port. Don't leave sessions running between debug runs unless you want the user to keep attaching to them.

## When tmux scroll-buffer parsing gets noisy

If async kernel logging or chatty services pollute your capture so badly that you can't reliably extract your command's output, fall back to SSH (\`avocado://skills/device-debugging\`). SSH gives you a separate channel per command and structured output. UART is for the cases where SSH isn't an option.
`;
