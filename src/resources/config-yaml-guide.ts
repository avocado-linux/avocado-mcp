export const URI = "avocado://skills/config-yaml-guide";
export const NAME = "config-yaml-guide";
export const DESCRIPTION =
  "How to author avocado.yaml — the structure of a project file, what each top-level key means, and the rules for safe edits. Read this before generating any YAML or invoking add-extension / add-runtime / add-package-to-extension.";

export const CONTENT = `# Authoring avocado.yaml

\`avocado.yaml\` is the single declarative file that describes an Avocado OS project. The avocado CLI consumes it for \`build\`, \`install\`, \`provision\`, \`sdk run\`, etc. The **authoritative source of truth** for valid structure is the JSON Schema at \`github.com/avocado-linux/avocado-config/avocado-config.json\`. **Always** fetch and read the schema (\`get-config-schema\` tool) before generating or modifying YAML.

## Top-level keys (most common)

\`\`\`yaml
default_target: <target-string>     # which target the CLI builds for by default
supported_targets: ["*"] | [<target>, ...]   # optional whitelist

distro:
  release: 2024
  channel: edge                     # also: stable

sdk:
  image: docker.io/avocadolinux/sdk:{{ config.distro.release }}-{{ config.distro.channel }}
  container_args: [...]             # e.g. --privileged, mounts
  packages:
    avocado-sdk-toolchain: "*"

runtimes:                           # one or more named deployment profiles
  dev:
    extensions:
      - avocado-ext-dev             # SSH + debug tools
      - avocado-ext-sshd-dev
      - avocado-bsp-<target>        # BSP for the target
      - app                         # the user's app
    packages:
      avocado-runtime: "*"

extensions:                         # extension definitions referenced by runtimes
  app:
    types: [sysext, confext]        # sysext = /usr; confext = /etc
    version: "0.1.0"
    packages:
      curl: "*"                     # package names MUST be verified
      openssl: "*"
    overlay: overlays/app           # path to overlay files
    enable_services:
      - my-app.service

  avocado-ext-dev:
    source:
      type: package                 # this extension comes from the package repo
      version: "*"
\`\`\`

## Rules an LLM must follow

1. **Schema-first.** Call \`get-config-schema\` before generating or modifying any YAML. Don't guess key names, value types, or enum values.
2. **Target must be in the enum.** The \`target\` field has a fixed enum in the schema. Use \`list-targets\` to find valid options.
3. **Every package must be verified.** Before adding a package to an extension or runtime, call \`search-packages\` (or \`describe-package\`) for the user's target and confirm the package exists. Never invent a package name.
4. **Extension types are constrained.** Only \`sysext\` and \`confext\` are valid. \`sysext\` extends \`/usr\`. \`confext\` extends \`/etc\`. Most apps want both.
5. **Don't break the \`dev\` runtime.** If the user is just getting started, keep \`avocado-ext-dev\` and \`avocado-ext-sshd-dev\` in their dev runtime — without these, they can't SSH or debug.
6. **Prefer the helper tools** over hand-edited YAML. \`add-extension\`, \`add-runtime\`, \`add-package-to-extension\` all validate the result against the schema before returning.

## What's NOT in the schema

The schema validates *structure*, not *semantics*:
- It doesn't know whether a package name exists.
- It doesn't know whether your extension actually builds.
- It doesn't know whether a runtime's packages will fit in the image.

Those are the user's (or \`avocado build\`'s) job to discover. The MCP can verify package names — anything else is left to the build.
`;
