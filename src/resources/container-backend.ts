export const URI = "avocado://skills/container-backend";
export const NAME = "container-backend";
export const DESCRIPTION =
  "Where Avocado gets Docker on the development host, per platform. On macOS, the avocado-vm supplies dockerd and Docker Desktop is not necessary. On Linux, the CLI uses the native Docker Engine. Read this after a Docker or daemon error, when the user asks about Docker installation, or before you tell anyone to install Docker Desktop.";

export const CONTENT = `# The container backend (where Docker comes from)

Every \`avocado build\`, \`avocado install\`, and \`avocado provision\` runs inside
the SDK container. Thus the host needs a container engine. The source of that
engine depends on the platform. Know the platform before you tell a user to
install anything.

The supported platforms are macOS and Linux. Windows support is highly
experimental and not suggested.

## macOS — the avocado-vm supplies Docker

On macOS, assume the avocado-vm is the container engine. A Mac user on plain
Docker Desktop is rare. Docker Desktop is not necessary. The \`avocado\` CLI
includes a helper VM (\`avocado-vm\`). This is a QEMU virtual machine that runs
\`dockerd\` inside it. The CLI connects to it automatically:

- The CLI forwards the socket \`/run/docker.sock\` from the VM to a local socket
  (\`~/.avocado/vm/docker.sock\`) with SSH. Then it sets \`DOCKER_HOST\` for its own
  subprocesses. Each \`docker\` command from the CLI works. You do not need Docker
  Desktop or a manual \`docker context\`.
- If the VM is not running when a build starts, the CLI auto-starts it only
  when \`AVOCADO_VM_DIR\` points at the install. A plain \`avocado vm update\` does
  not set that variable. Thus the build does not auto-start the VM — run
  \`avocado vm start\` first. But \`avocado vm update\` can restart a VM that is
  already running. In that case, do not run \`avocado vm start\` again, because
  it errors on a running VM.

The CLI sets \`DOCKER_HOST\` only in its own process. A \`docker info\` command that
you run does not see the daemon in the VM. Thus a Docker failure on the host is
not proof of a broken environment on a Mac. Examine the VM, not bare Docker.

The VM can hibernate. A hibernated VM is still available: \`avocado vm status\`
shows it as running, and the CLI or the Avocado desktop wakes it on the next
ssh or docker call. Do not treat a hibernated VM as stopped.

### First-time setup (macOS)

\`\`\`bash
avocado vm update -y   # download and install the prebuilt avocado-vm release
avocado vm start       # boot it — start it before you build
\`\`\`

Run \`avocado vm update\` with \`-y\`. Without \`-y\` the command asks for
confirmation and stops when there is no terminal (for example, an agent runs
it off a pipe).

You do not build the VM from source. The command \`avocado vm update\` gets a
prebuilt image. Docker Desktop is necessary only to build the VM from source.
This is not a usual task.

### VM lifecycle commands

\`avocado vm start | stop | status | logs | shell | config | rebuild | reset | update\`

- \`avocado vm status\` — shows if the VM runs, and the ssh port.
- \`avocado vm start\` and \`avocado vm stop\` — boot or stop the VM.
- \`avocado vm logs\` — show the VM serial log after a boot failure.
- \`avocado vm shell\` — open an SSH shell in the VM to debug the engine.

The VM keeps SDK images and Docker volumes in its persistent storage. They stay
after a restart. Thus builds stay fast.

### Opt out of the VM (macOS)

The CLI uses the VM by default. To make the CLI use a local Docker daemon
instead, use one of these options:

- \`--no-vm-auto-start\`
- \`AVOCADO_VM_AUTO_START=0\`
- \`--runs-on <host>\` (the older remote-Docker path)

## Linux — native Docker Engine

On Linux, the CLI connects to the native Docker Engine on the host. The CLI does
not use the avocado-vm. Install Docker Engine (not Docker Desktop). Then make
sure that the daemon runs:

\`\`\`bash
sudo systemctl start docker
docker info        # must succeed
\`\`\`

## Debug Docker and daemon errors — where to look

| Symptom | macOS | Linux |
|---|---|---|
| "Cannot connect to the Docker daemon" | Run \`avocado vm status\`. If the VM is stopped, run \`avocado vm start\` (first time: \`avocado vm update -y\` first). If the VM runs but the socket forward is missing, run \`avocado vm stop && avocado vm start\`. Do not run \`sudo systemctl start docker\`, because there is no host daemon. | Run \`sudo systemctl start docker\`. |
| Build stopped for out of memory | The build runs in the avocado-vm. Give the VM more memory: run \`avocado vm stop\`, then \`avocado vm start --memory-mib <MiB> --cpus <n>\` (a running VM rejects the flags, so stop it first). The values persist to \`~/.avocado/vm/config.yaml\`. Do not change Docker Desktop Resources. | Raise host limits or free RAM. |
| SDK image pull fails | Make sure that the VM has network (\`avocado vm shell\`, then \`docker pull <tag>\`). The VM caches images across restarts, so a retry is cheap. | Examine host network, or run \`docker pull\` directly. |

## Do not look inside the SDK container — on any platform

The CLI controls the build. Its stdout and stderr are the contract. Do not use
\`docker logs\`, \`docker ps\`, or \`docker exec\` to inspect the SDK container. That
is unreliable, and the container backend changes. Read the output from
\`avocado\`, not its internal state.

## On the device — there is no Docker

This page is about the development host. The device is not a Docker host. The
Avocado model uses extensions, not containers. To put container images on a
device, pull them at build time with \`extensions.<name>.docker_images\`. For
more information, see \`avocado://skills/filesystem-model\`.
`;
