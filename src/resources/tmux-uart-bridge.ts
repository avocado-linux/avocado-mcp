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

## Sending a command

\`\`\`bash
tmux send-keys -t avocado-uart 'journalctl -xeu my-app.service --no-pager' Enter
\`\`\`

**Important:** always use \`Enter\` as a separate \`send-keys\` argument (not \`\\n\` inside the string). \`tmux send-keys -t ... 'cmd\\n'\` sends the literal characters \`\\\` and \`n\`, not a newline.

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
