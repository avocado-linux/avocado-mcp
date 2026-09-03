export const URI = "avocado://skills/container-backend";
export const NAME = "container-backend";
export const DESCRIPTION =
  "Where Avocado gets Docker on the development host, per platform. On macOS and Windows, the avocado-vm supplies dockerd and Docker Desktop is not necessary. On Linux, the CLI uses the native Docker Engine. Read this after a Docker or daemon error, when the user asks about Docker installation, or before you tell anyone to install Docker Desktop.";

export const CONTENT = `# The container backend (where Docker comes from)

Every \`avocado build\`, \`avocado install\`, and \`avocado provision\` runs inside
the SDK container. Thus the host needs a container engine. The source of that
engine depends on the platform. Know the platform before you tell a user to
install anything.

## macOS and Windows — the avocado-vm supplies Docker

Docker Desktop is not necessary. The \`avocado\` CLI includes a helper VM
(\`avocado-vm\`). This is a QEMU virtual machine that runs \`dockerd\` inside it.
The CLI connects to it automatically:

- The CLI forwards the socket \`/run/docker.sock\` from the VM to a local socket
  (\`~/.avocado/vm/docker.sock\`) with SSH. Then it sets \`DOCKER_HOST\` for its own
  subprocesses. Each \`docker\` command from the CLI works. You do not need Docker
  Desktop or a manual \`docker context\`.
- If the VM is not running, the CLI starts it automatically. The CLI finds the
  VM from a running instance, the \`AVOCADO_VM_DIR\` variable, or an install from
  \`avocado vm update\`.

The CLI sets \`DOCKER_HOST\` only in its own process. A \`docker info\` command that
you run does not see the daemon in the VM. Thus a Docker failure on the host is
not proof of a broken environment on a Mac. Examine the VM, not bare Docker.

### First-time setup (macOS and Windows)

\`\`\`bash
avocado vm update      # download and install the prebuilt avocado-vm release
avocado vm start       # boot it (also starts automatically on your first build)
\`\`\`

You do not build the VM from source. The command \`avocado vm update\` gets a
prebuilt image. Docker Desktop is necessary only to build the VM from source.
This is not a usual task.

### VM lifecycle commands

\`avocado vm start | stop | status | logs | shell | config | rebuild | reset | update\`

- \`avocado vm status\` — shows if the VM runs, and the ssh port.
- \`avocado vm start\` and \`avocado vm stop\` — boot or stop the VM.
- \`avocado vm logs\` — show the VM serial log after a boot failure.
- \`avocado vm shell\` — open an SSH shell in the VM to debug the engine.

The VM keeps a persistent \`/data\` disk. SDK images and Docker volumes stay after
a rootfs rebuild. Thus builds stay fast after a restart.

### Opt out of the VM (macOS and Windows)

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

| Symptom | macOS and Windows | Linux |
|---|---|---|
| "Cannot connect to the Docker daemon" | Run \`avocado vm status\`. If the VM is stopped or missing, run \`avocado vm start\` (or \`avocado vm update\` first). Do not run \`sudo systemctl start docker\`, because there is no host daemon. | Run \`sudo systemctl start docker\`. |
| Build stopped for out of memory | The build runs in the avocado-vm. Give the VM more memory and CPUs (\`avocado vm start --memory-mib <MiB> --cpus <n>\`; both persist to \`~/.avocado/vm/config.yaml\`). Do not change Docker Desktop Resources. | Raise host limits or free RAM. |
| SDK image pull fails | Make sure that the VM has network (\`avocado vm shell\`, then \`docker pull <tag>\`). The VM caches images on \`/data\`, so a retry is cheap. | Examine host network, or run \`docker pull\` directly. |

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
