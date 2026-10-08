export const URI = "avocado://skills/config-yaml-guide";
export const NAME = "config-yaml-guide";
export const DESCRIPTION =
  "How to author avocado.yaml — the structure of a project file, what each top-level key means, and the rules for safe edits. Read this before generating any YAML or invoking add-extension / add-runtime / add-package-to-extension.";

export const CONTENT = `# Authoring avocado.yaml

\`avocado.yaml\` is the single declarative file that describes an Avocado OS project. The avocado CLI reads it for \`install\`, \`build\`, \`provision\`, \`deploy\`, \`sdk run\` and the other commands.

The source of truth for its structure is the JSON Schema that the avocado CLI ships (\`avocado-cli/schemas/avocado-config.json\`). The docs site serves it at \`https://docs.peridio.com/schemas/avocado-config.json\`. Get it with the \`get-config-schema\` tool before you generate or change YAML.

## Start a project with \`avocado init\`

Run \`avocado init --target <target> [<project-dir>]\` to create a new project. It writes \`avocado.yaml\` from the template of the installed CLI. \`init-project\` gives you the command and the edits to make after it. Edit the generated file. Do not write one from memory.

## The default template

This is what \`avocado init --target <target>\` writes (comments removed):

\`\`\`yaml
# yaml-language-server: $schema=https://docs.peridio.com/schemas/avocado-config.json
cli_requirement: ">=0.41.0"         # semver range the running CLI must satisfy
default_target: "<target>"          # target used when --target is not given
supported_targets:                  # or "*" for all targets
  - <target>

distro:
  release: 2024                     # feed year: 2024 or 2026
  channel: edge                     # next, edge or stable

runtimes:                           # named deployment profiles
  dev:
    extensions:
      - avocado-ext-dev             # SSH + debug tools
      - avocado-ext-sshd-dev
      - avocado-bsp-{{ avocado.target.board }}   # BSP for the target or board
      - app                         # the user's app
    packages:
      avocado-runtime: "*"

extensions:                         # extension definitions referenced by runtimes
  avocado-ext-dev:
    source:
      type: package                 # comes from the package feed
      version: "*"
  avocado-ext-sshd-dev:
    source:
      type: package
      version: "*"
  avocado-bsp-{{ avocado.target.board }}:
    source:
      type: package
      version: "*"
  app:
    types: [sysext, confext]        # sysext = /usr, confext = /etc
    version: "0.1.0"

rootfs:
  permissions: dev                  # users and groups baked into the rootfs
initramfs:
  permissions: dev

permissions:                        # top-level users and groups profiles
  dev:
    users:
      root:
        password: ""                # NOT FOR PRODUCTION

sdk:
  image: "docker.io/avocadolinux/sdk:{{ config.distro.release }}"
  container_args: [--privileged, --network=host, -v /dev:/dev, -v /sys:/sys]
  packages:
    avocado-sdk-toolchain: "*"
\`\`\`

## Keys you will often add

- \`default_target_board\`: the board for a module that ships on more than one carrier board, for example \`mic-712-ox-16gb\` on \`jetson-orin-nx\`. It sets \`{{ avocado.target.board }}\`. Without it, the board is the target.
- \`distro.repo\`: a feed other than the default. Use \`{url: ...}\`, or the name of an entry under \`repos:\`.
- Extension fields: \`packages\`, \`overlay\`, \`enable_services\`, \`modprobe\`, \`depends_on\`, \`image\`.
- Extension \`source\`: \`{type: package, version}\`, \`{type: git, url, ref}\` or \`{type: path, path}\`.
- \`kernel.cmdline\` or \`kernel.cmdline_extra\` (not both).

Users and groups go in a top-level \`permissions:\` profile, referenced from \`rootfs.permissions\` and \`initramfs.permissions\`. The \`users:\` and \`groups:\` keys on an extension are deprecated.

## Rules an LLM must follow

1. **Schema-first.** Call \`get-config-schema\` before generating or modifying any YAML. Don't guess key names, value types, or enum values.
2. **Targets come from the feed.** The schema accepts any target string. Use \`list-targets\` to find the targets the feed has.
3. **Every package must be verified — against the project's feed.** Before adding a package to an extension or runtime, call \`search-packages\` (or \`describe-package\`) for the user's target **with \`projectDir\`** and confirm the package exists. Package sets differ between releases/channels, so a hit on the default 2024/edge feed doesn't prove the package exists on the project's feed. Never invent a package name.
4. **Extension types are constrained.** Only \`sysext\` and \`confext\` are valid. \`sysext\` extends \`/usr\`. \`confext\` extends \`/etc\`. Most apps want both.
5. **Don't break the \`dev\` runtime.** If the user is just getting started, keep \`avocado-ext-dev\` and \`avocado-ext-sshd-dev\` in their dev runtime — without these, they can't SSH or debug.
6. **Prefer the helper tools** over hand-edited YAML. \`add-extension\`, \`add-runtime\`, \`add-package-to-extension\` all validate the result against the schema before returning.
7. **Fix warnings too.** The CLI ignores a key the schema does not describe and prints a warning. \`validate-yaml\` reports the same warnings. A typo such as \`enable_service\` does not fail the build, but the setting has no effect.

## What's NOT in the schema

The schema validates *structure*, not *semantics*:
- It doesn't know whether a package name exists.
- It doesn't know whether your extension actually builds.
- It does not check every rule the CLI checks at build time. For example, \`signing.fit_key\` and \`signing.fit_unsigned\` together fail the build but pass the schema.

Those are the user's (or \`avocado build\`'s) job to discover. The MCP can verify package names — anything else is left to the build.
`;
