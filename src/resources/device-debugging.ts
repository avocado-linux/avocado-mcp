export const URI = "avocado://skills/device-debugging";
export const NAME = "device-debugging";
export const DESCRIPTION =
  "How to debug a running Avocado OS device. **UART-over-serial is the default channel** — ALWAYS start here, even if the user has provided an IP. SSH is a fallback only after UART confirms the device booted and is healthy. Serial parameters are canonical: 115200 baud, 8N1, no flow control. Read this BEFORE invoking detect-serial-ports, get-device-connection-info, or get-tmux-uart-snippet.";

export const CONTENT = `# Debugging an Avocado OS device

Avocado OS gives you two channels into a running device. **UART comes first. Always.**

## The non-negotiable default: UART

The Avocado getting-started flow requires every user to have a USB-to-UART adapter (3.3V TTL). The serial console is:

- **The only channel that works when the device isn't on the network** (no IP yet, broken DHCP, bad WiFi config, sshd didn't start).
- **The only channel that shows the boot sequence** — bootloader, kernel boot messages, systemd's startup, every service coming up.
- **The canonical channel for "device won't boot" / "I just provisioned and nothing happened"** kinds of bugs.
- **Authoritative even when the device LOOKS reachable.** If \`ping\` succeeds but \`ssh\` hangs, UART tells you whether sshd ever started.

### Why this is the default — even when the user has an IP

This is the most common mistake to make:

> "User said \`ssh root@192.168.1.42\` works. Skip UART, go straight to SSH."

**Don't.** An IP only tells you the kernel + early userspace got far enough to bring up networking. It doesn't tell you whether the service the user actually cares about started, whether \`/var\` mounted, whether disks are healthy, or whether sshd will *keep* working under the load you're about to put on it. UART is the only channel that survives all of those failures.

**Rule:** start every debug session on UART. Only move to SSH after UART confirms the device is healthy enough that SSH is reliable, OR if the user explicitly opts out of UART.

### Connection parameters — canonical

These are fixed across every supported Avocado target unless \`get-device-connection-info\` says otherwise for a specific board:

- **Baud:** 115200
- **Format:** 8N1 (8 data bits, no parity, 1 stop bit)
- **Flow control:** none
- **Voltage:** 3.3V TTL (exception: x86 boards, RS-232 levels — \`get-device-connection-info\` flags these)

**Do not ask the user to confirm these.** They are the documented default. Per-target overrides come from \`get-device-connection-info\`, not from the user.

### First moves on a fresh UART session

When the bridge comes up you'll usually see one of three things in \`tmux capture-pane\` output:

1. **A login prompt** (\`<hostname> login:\`). The \`dev\` runtime ships with a passwordless root account. Send \`root\` and press Enter:
   \`\`\`bash
   tmux send-keys -t avocado-uart 'root' Enter
   \`\`\`
   No password prompt should follow. If one does, the device is NOT running the \`dev\` runtime — note that and proceed with whatever credentials the user provides.
2. **An already-logged-in shell** (the prompt is already \`#\` or \`<hostname>:~#\`). Skip the login step — you're in. Optionally hit Enter once to confirm:
   \`\`\`bash
   tmux send-keys -t avocado-uart '' Enter
   \`\`\`
3. **Active boot output / no prompt yet.** Wait. Capture again in a few seconds. If still nothing, capture more lines (\`-S -1000\`) and look for kernel panic / mount failures.

**Do not assume you're already logged in.** Always check the capture for a login prompt before sending any other commands — sending a system command to a login prompt just types your command as the username and fails.

## SSH — for steady-state work, AFTER UART confirms health

The \`dev\` runtime ships with \`avocado-ext-sshd-dev\` enabled and a passwordless root account. Once UART has confirmed the device booted cleanly and the symptom the user cares about isn't network-related, you can:

\`\`\`bash
ssh root@<device-ip-or-hostname>
\`\`\`

…and run anything: \`journalctl\`, \`systemctl\`, \`dmesg\`, file inspection. SSH is **better than UART for**:

- Long log scans (no scrollback parsing fragility).
- Multi-line filters (\`journalctl -xeu my-app.service --since '5 min ago' -p err\`).
- File transfer (\`scp\`).
- Running multiple commands in parallel.

It's **worse than UART for**:

- Anything pre-boot or pre-network.
- Watching live boot messages.
- Diagnosing why SSH itself isn't working.
- Catching the device when a service is about to take it down.

## Recommended flow

1. **Default to UART.** Call \`detect-serial-ports\` for the adapter + emulator availability, \`get-device-connection-info\` for the (canonical) baud/voltage/credentials, and \`get-tmux-uart-snippet\` for the session-setup command. **Do this even if the user told you the device has an IP.**
2. **Log in if necessary.** Check the captured pane for a login prompt; if present, send \`root\` then Enter. If you already see a \`#\` prompt, you're in.
3. **Run the standard diagnostic battery** (see below) and report.
4. **Only then**, if the user wants heavier interactive work and UART confirms the device is healthy, switch to SSH (\`ssh root@<host> '<command>'\` via Bash directly — no MCP tool needed).

For the tmux-over-UART pattern in detail, read \`avocado://skills/tmux-uart-bridge\`. For on-device tooling quirks (BusyBox vs GNU, what \`journalctl\` flags work, etc.), read \`avocado://skills/avocado-runtime-details\`.

## Reading existing logs effectively

Before adding more logging, exhaust what's already there. Avocado devices run full systemd + journald, so most application output is already captured. The order to try, from most-likely-to-be-useful first:

\`\`\`bash
# 1. Is anything failing right now?
systemctl --failed --no-pager

# 2. The unit you care about — status + recent log lines in one shot
systemctl status my-app.service --no-pager -n 30

# 3. Targeted journal scan for the unit, last boot only, bounded
journalctl -xeu my-app.service --no-pager -b | tail -100

# 4. Just errors across the whole system since boot
journalctl -p err -b --no-pager | tail -50

# 5. Kernel-side issues (driver / hardware)
dmesg --color=never | tail -50

# 6. Did the unit get the right environment?
systemctl show my-app.service --no-pager -p Environment -p ExecStart -p WorkingDirectory

# 7. Is the process actually running and what's it doing?
ps -ef | grep my-app
\`\`\`

If the symptom is "service crashes/restarts": look at \`systemctl status\` for the exit code and last log lines. \`journalctl -xeu <unit>\` shows the crash output in context with systemd's own restart messages.

If the symptom is "service runs but does the wrong thing": you need the app's own log output, which means... add more logging.

## When existing logs aren't enough: add more, then redeploy

**You can iterate on the project to give yourself better signal.** If the on-device logs don't explain the failure, the right move is often to add temporary debug logging to the app, redeploy, and re-read. The full iteration loop is fast — \`avocado install -f --no-tui\` (if extensions changed) → \`avocado build --no-tui\` → \`avocado deploy -r dev -d <device-ip> --no-tui\` → re-read the unit's log. See \`avocado://skills/iterative-deployment\` for the exact mechanics.

What to edit depends on what kind of code is failing:

### Python apps (e.g. \`python-flask\`, \`python-mqtt\`)

The app source lives under \`app/\` in the project. Add or escalate logging:

\`\`\`python
import logging
logging.basicConfig(
    level=logging.DEBUG,                                              # was INFO
    format='%(asctime)s %(name)s %(levelname)s %(message)s',
)
\`\`\`

Or sprinkle targeted \`logging.debug(...)\` / \`print(..., flush=True, file=sys.stderr)\` at the lines you suspect. \`print\` without \`flush=True\` may not surface in journalctl on a crash.

### Node.js apps (e.g. \`nodejs-dashboard\`)

\`\`\`js
process.env.LOG_LEVEL = 'debug';                  // if the app honors it
console.error('DBG: about to call X', { input }); // forces stderr (captured by journald)
\`\`\`

### C / C++ binaries (e.g. \`c-gpio\`, \`cpp-tui-dashboard\`)

Use \`fprintf(stderr, ...)\` (NOT \`stdout\` — line buffering may swallow it on crash). Recompile via the build hook — \`avocado build --no-tui\` will pick up the change.

### Rust binaries (e.g. \`rust-vitals\`)

If the project already uses \`env_logger\` / \`tracing-subscriber\`, set the level via the systemd unit's environment:

\`\`\`ini
# in app/overlay/usr/lib/systemd/system/my-app.service
Environment=RUST_LOG=debug
\`\`\`

Otherwise add \`eprintln!("DBG: ...")\` directly in the suspect code.

### systemd unit configuration

If you suspect the unit is starting with the wrong arguments / environment / working directory, edit the unit file at \`app/overlay/usr/lib/systemd/system/<unit>.service\`:

\`\`\`ini
[Service]
ExecStart=/usr/bin/my-app --verbose --log-level debug   # add flags the app already supports
Environment=RUST_LOG=debug
Environment=NODE_ENV=development
StandardOutput=journal
StandardError=journal
\`\`\`

After deploying, run \`systemctl daemon-reload\` is NOT needed — the deploy mechanism handles it, but you may need to restart the unit: \`systemctl restart my-app.service\`.

### Need persistent state across boots / process restarts?

Write debug output to \`/var/log/my-app-debug.log\` (\`/var\` is the only writable partition — see \`avocado://skills/filesystem-model\`). Then \`tail -200 /var/log/my-app-debug.log\` on next session.

### The closed-loop debug cycle

1. Read existing logs (the 7-step recipe above).
2. If inconclusive, identify the smallest code change that adds the missing signal — usually a few extra log statements in the suspect function, OR a log-level escalation in the systemd unit.
3. Build + deploy via \`/build-and-deploy\` (the prompt) or manually:
   \`\`\`bash
   avocado build --no-tui > /tmp/avocado-build.log 2>&1 && \\
   avocado deploy -r dev -d <device-ip> --no-tui
   \`\`\`
4. Restart the unit on the device (if your change doesn't itself trigger a restart): \`systemctl restart my-app.service\` via the UART session or SSH.
5. Reproduce the symptom.
6. Re-read the new logs.
7. Repeat or fix.

**Clean up afterward.** Before declaring a bug fixed, remove the debug logging you added — or at least drop the level back to INFO and remove ad-hoc \`print\`/\`eprintln\` calls. The references stay clean for a reason; don't leave \`DBG:\` strings in committed code.

## Common starting moves once you have a session

Whether you're on UART or SSH, the first questions to ask are usually:

\`\`\`bash
# Did any service fail?
systemctl --failed

# What's the most recent error?
journalctl -p err -b --no-pager | tail -50

# Specific service status + logs?
systemctl status my-app.service
journalctl -xeu my-app.service --no-pager

# Anything weird in kernel land?
dmesg --color=never | tail -30

# Is networking up?
ip a
ip r
\`\`\`

Tailor from there based on what comes back.
`;
