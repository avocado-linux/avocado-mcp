# Security & Responsible Use

The Avocado OS MCP Server lets an AI assistant act as a hands-on Avocado OS
co-pilot. To do that job it does not just return text — it can **execute real
operations on your behalf**, including running `avocado` CLI commands, editing
project files, and provisioning or updating physical hardware.

Please read this document before connecting the server to an AI client. Using
the server means you accept the responsibilities described here.

## The security model

This server implements [Model Context Protocol](https://modelcontextprotocol.io)
tools. As the MCP specification states, **tools represent arbitrary code
execution and must be treated with appropriate caution.** The protocol is built
on the principle that the *host application and the user* — not the tool server —
are responsible for deciding whether any given action runs:

- **You (and your MCP client) control execution.** The AI *proposes* actions;
  your MCP client is responsible for obtaining your consent before any tool is
  invoked. Run your client with tool-confirmation / explicit-approval prompts
  enabled, and review each proposed action before you approve it.
- **The server trusts the caller.** It does not, and cannot, distinguish a
  well-intentioned request from a mistaken or malicious one. Guardrails live in
  your client and in the permissions of the environment you run it in.
- **Actions run with your privileges.** Commands execute with whatever user,
  credentials, network access, and device access you give the client. Scope
  those deliberately (see *Recommended safeguards*).

## Operations that can change or destroy state

Most tools are read-only (searching packages, reading docs and references,
validating YAML). The following can modify files, systems, or devices, and
should be reviewed carefully every time before you approve them:

- **File and project changes** — `init-project`, `add-extension`,
  `add-runtime`, `add-package-to-extension`, and any authoring of `avocado.yaml`
  create or overwrite files in your working directory.
- **CLI execution** — the server drives `avocado install` / `build` / `deploy`
  / `provision`, either through the Avocado desktop tool or by running commands
  on the host. These can overwrite build state and take a long time.
- **Device provisioning** — `avocado provision` **flashes media (SD / USB /
  NVMe) and erases its existing contents.** This is destructive and irreversible
  for whatever was on that media.
- **Device updates** — `avocado deploy` sideloads runtime updates onto a running
  device over SSH/HTTP, changing the software on that device.
- **Remote/fleet operations** — `connect-*` tools can upload, publish, and roll
  out updates to enrolled production devices.

## Recommended safeguards

You are responsible for the environment the server runs in. We strongly
recommend:

1. **Use version control.** Work in a git repository with a clean tree so any
   AI-made file change can be reviewed with `git diff` and reverted.
2. **Keep backups.** Do not point destructive operations at media or devices
   whose contents you cannot afford to lose.
3. **Review before approving.** Read each proposed command or file edit before
   granting consent — especially provision, deploy, and file writes.
4. **Run with least privilege.** Use scoped credentials and tokens, not
   root/admin or full-account access. `GITHUB_TOKEN`, if set, should be a
   read-only token with the minimum scope needed for API rate limits.
5. **Confirm device targets.** Double-check the media path or device IP before
   flashing or deploying — the server acts on whatever target you provide.

## Data and privacy

- The server itself makes outbound requests to **public HTTPS endpoints only**:
  - `repo.avocadolinux.org` — RPM package feed.
  - `api.github.com` and `raw.githubusercontent.com` — reference projects and
    documentation manifests/content (an optional, read-only `GITHUB_TOKEN`
    only raises GitHub API rate limits).
  - `docs.peridio.com` — documentation content.

  See the *How it talks to the world* section of the README for details.
- It is **stdio-only**: there is no hosted endpoint, no listening port, and no
  API key issued by us.
- The `connect-*` fleet tools do not call those endpoints directly — they invoke
  your locally installed `avocado` CLI, which reaches Peridio services using the
  credentials you have already configured for that CLI. Those credentials and
  their handling are managed by you and the CLI, not by this server.
- Caches are written locally under `~/.cache/avocado-mcp/`. No usage data is
  sent to Peridio by the server itself. Your AI client and any CLI/credentials
  you configure have their own data-handling terms, which are outside this
  server's control.

## Reporting a vulnerability

If you discover a security vulnerability in this server, please report it
privately rather than opening a public issue:

- Email **security@peridio.com**, or
- Use GitHub's private
  ["Report a vulnerability"](https://github.com/avocado-linux/avocado-mcp/security/advisories/new)
  advisory flow.

Please include steps to reproduce and the affected version. We will acknowledge
your report and keep you updated on remediation.

## No warranty

This software is provided under the Apache License 2.0 on an **"AS IS" basis,
without warranties or conditions of any kind**, and the licensor is not liable
for damages arising from its use. See the [LICENSE](./LICENSE) file for the full
terms. The safeguards above are recommendations, not guarantees; responsibility
for how the tool is used, and for reviewing the actions it proposes, rests with
the user.
