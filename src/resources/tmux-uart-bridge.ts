export const URI = "avocado://skills/tmux-uart-bridge";
export const NAME = "tmux-uart-bridge";
export const DESCRIPTION =
  "The canonical pattern for letting Claude drive a UART serial console: a tmux session running `tio` that Claude controls via `tmux send-keys` and `tmux capture-pane`. Read this before invoking get-tmux-uart-snippet or trying to debug a device over UART.";

export const CONTENT = `# Driving a UART console through tmux

Claude's Bash tool runs commands that return and exit — it can't sit inside an interactive \`tio\` session and type. The pattern that works:

1. **The user starts a detached tmux session** with \`tio\` running inside, attached to the serial port.
2. **Claude sends commands** with \`tmux send-keys -t <session> '<cmd>' Enter\`.
3. **Claude reads output** with \`tmux capture-pane -t <session> -p -S -<lines>\`.

Both \`send-keys\` and \`capture-pane\` are one-shot and stateless — perfect for the Bash tool.

## One-time install (host machine)

\`\`\`bash
# macOS
brew install tmux tio

# Debian/Ubuntu
sudo apt install tmux tio
\`\`\`

\`tio\` is the cross-platform replacement for \`screen\` / \`minicom\` — simpler, scriptable, no funky terminal control sequences.

## Setup (run once per device session)

\`\`\`bash
# Replace /dev/tty.usbserial-XXX with the actual port from detect-serial-ports
tmux new-session -d -s avocado-uart 'tio -b 115200 /dev/tty.usbserial-XXX'
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
