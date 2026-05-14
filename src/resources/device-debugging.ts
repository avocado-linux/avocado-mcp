export const URI = "avocado://skills/device-debugging";
export const NAME = "device-debugging";
export const DESCRIPTION =
  "How to debug a running Avocado OS device. UART-over-serial is the default channel (every getting-started flow requires a USB-to-UART adapter); SSH is the alternative once the device is on the network. Read this BEFORE invoking detect-serial-ports, get-device-connection-info, or get-tmux-uart-snippet.";

export const CONTENT = `# Debugging an Avocado OS device

Avocado OS gives you two channels into a running device. Pick based on what you're trying to learn.

## 1. UART over serial (default — and always available)

The Avocado getting-started flow requires every user to have a USB-to-UART adapter (3.3V TTL). The serial console is:

- **The only channel that works when the device isn't on the network** (no IP yet, broken DHCP, bad WiFi config).
- **The only channel that shows the boot sequence** — bootloader, kernel boot messages, systemd's startup, every service coming up.
- **The canonical channel for "device won't boot" / "I just provisioned and nothing happened"** kinds of bugs.

This is the default. Reach for SSH only after the device is up and reachable.

## 2. SSH (alternative — for steady-state work)

The \`dev\` runtime ships with \`avocado-ext-sshd-dev\` enabled and a passwordless root account. Once the device has an IP, you can:

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

## Recommended flow

1. **Default to UART.** Use \`detect-serial-ports\` to find the adapter, \`get-device-connection-info\` for baud/voltage/credentials, and \`get-tmux-uart-snippet\` for the exact session-setup command.
2. **Switch to SSH** once the user confirms the device has an IP and you need to run heavier commands. Use Bash directly: \`ssh root@<host> '<command>'\`.

For the tmux-over-UART pattern in detail, read \`avocado://skills/tmux-uart-bridge\`. For on-device tooling quirks (BusyBox vs GNU, what \`journalctl\` flags work, etc.), read \`avocado://skills/avocado-runtime-details\`.

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
