/**
 * Bundled JSON Schema (draft 2020-12) for `avocado.yaml`.
 *
 * Authored against `avocado-cli/src/utils/config.rs` (the authoritative
 * deserialization struct) and cross-checked against the references shipped
 * in `github.com/avocado-linux/references`. The upstream
 * `avocado-linux/avocado-config` repo currently publishes a schema for
 * `avocado.toml`, not the YAML form — until that repo gains a YAML schema,
 * this file is the MCP's source of truth.
 *
 * Policy:
 *   - `additionalProperties: true` at the root. The CLI's Config struct
 *     accepts a broad set of optional top-level fields (some used by tooling
 *     not on the schema's radar), and `serde` ignores unknown keys.
 *   - Required at the root is only `{ distro, runtimes }`. Real references
 *     in the wild ship without `sdk:` (e.g. `shell-heartbeat`) or without
 *     `extensions:` (some HITL-only configs).
 *   - Open elsewhere (extension defs vary widely across references).
 *   - Templating like `{{ avocado.target }}` / `{{ avocado.target.board }}`
 *     is just a string value; schema doesn't need to know about it.
 */

export const AVOCADO_YAML_SCHEMA: object = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://avocado.com/schemas/avocado-yaml/0.2.0.json",
  title: "Avocado OS project configuration (avocado.yaml)",
  type: "object",
  additionalProperties: true,
  required: ["distro", "runtimes"],

  properties: {
    // ─── Identity / scope ─────────────────────────────────────────────────
    cli_requirement: {
      type: "string",
      description:
        "Minimum avocado CLI version (semver range, e.g. '>=0.26.0').",
    },

    source_date_epoch: {
      oneOf: [{ type: "integer", minimum: 0 }, { type: "string" }],
      description:
        "SOURCE_DATE_EPOCH timestamp for reproducible builds (Unix seconds).",
    },

    src_dir: {
      type: "string",
      description:
        "Source directory the project root resolves against (relative or absolute).",
    },

    default_target: {
      type: "string",
      description:
        "Default target name used when `avocado build` / `provision` is called without `--target`.",
    },

    default_target_board: {
      type: "string",
      description:
        "Default board variant within the target. Lowest-priority resolution for `{{ avocado.target.board }}`; overridden by `AVOCADO_TARGET_BOARD`.",
    },

    default_runtime: {
      type: "string",
      description:
        "Default runtime name for commands that scope by runtime. Used when no `-r/--runtime` flag and no `AVOCADO_RUNTIME` env var are set. Must reference a key under `runtimes:`.",
    },

    supported_targets: {
      description:
        "Targets this project supports. '*' means all targets known to the package feed.",
      oneOf: [
        { type: "string", enum: ["*"] },
        { type: "array", items: { type: "string" }, minItems: 1 },
      ],
    },

    // ─── Distro / feed ────────────────────────────────────────────────────
    distro: {
      type: "object",
      description: "Avocado distribution stream the project pulls from.",
      properties: {
        release: {
          description: "Release year (e.g. 2024) — string or number accepted.",
          oneOf: [{ type: "string" }, { type: "integer" }],
        },
        channel: {
          type: "string",
          description:
            "Release channel (e.g. 'edge'). Verified at install time against the package feed.",
        },
        repo: {
          type: "object",
          description: "Optional override for the upstream package repo.",
          properties: {
            url: { type: "string" },
            releasever: { type: "string" },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },

    // ─── Runtimes / extensions ────────────────────────────────────────────
    runtimes: {
      type: "object",
      description:
        "Named compositions of extensions. Each key is a runtime name (e.g. 'dev', 'prod'). The CLI accepts `-r <name>` against any key declared here.",
      minProperties: 1,
      additionalProperties: { $ref: "#/$defs/runtime" },
    },

    extensions: {
      type: "object",
      description:
        "Named extensions referenced by runtimes. Two shapes: package-sourced (with `source: {type: package, version: ...}`) or app-style (no source; built in-tree from `app/` + hook scripts).",
      additionalProperties: { $ref: "#/$defs/extension" },
    },

    // ─── SDK / build environment ─────────────────────────────────────────
    sdk: { $ref: "#/$defs/sdk" },

    // ─── Top-level image / kernel definitions ────────────────────────────
    rootfs: {
      description:
        "Top-level rootfs image config. Accepts either a singleton object (synthesized as the implicit `default` entry) or a `name → config` map.",
      oneOf: [
        { $ref: "#/$defs/imageConfig" },
        {
          type: "object",
          additionalProperties: { $ref: "#/$defs/imageConfig" },
        },
      ],
    },

    initramfs: {
      description:
        "Top-level initramfs image config. Same singleton-or-map shape as rootfs.",
      oneOf: [
        { $ref: "#/$defs/imageConfig" },
        {
          type: "object",
          additionalProperties: { $ref: "#/$defs/imageConfig" },
        },
      ],
    },

    kernel: {
      description:
        "Top-level kernel definition. Singleton-or-map. A config with only `version:` set acts as a version constraint applied across runtimes that don't pin their own.",
      oneOf: [
        { $ref: "#/$defs/kernelConfig" },
        {
          type: "object",
          additionalProperties: { $ref: "#/$defs/kernelConfig" },
        },
      ],
    },

    permissions: {
      description:
        "Top-level permissions definitions. Singleton-or-map. Each entry is a `{users, groups}` block referenced by name from `rootfs.<name>.permissions` / `initramfs.<name>.permissions`. Lets the same users/groups be reused across multiple images.",
      oneOf: [
        { $ref: "#/$defs/permissionsConfig" },
        {
          type: "object",
          additionalProperties: { $ref: "#/$defs/permissionsConfig" },
        },
      ],
    },

    // ─── Provisioning / signing / fleet ──────────────────────────────────
    provision_profiles: {
      type: "object",
      description:
        "Named provisioning profiles. Each profile passes extra container args / state-file overrides to `avocado provision -P <name>`.",
      additionalProperties: { $ref: "#/$defs/provisionProfile" },
    },

    signing_keys: {
      type: "object",
      description:
        "Friendly-name → key-ID mapping for the global signing-key registry. Lets runtime / extension configs reference keys by short alias.",
      additionalProperties: { type: "string" },
    },

    connect: {
      type: "object",
      description:
        "Peridio Connect fleet integration (org / project / server-key references).",
      properties: {
        org: { type: "string" },
        project: { type: "string" },
        server_key: { type: "string" },
      },
      additionalProperties: true,
    },
  },

  $defs: {
    runtime: {
      type: "object",
      description:
        "A runtime definition. Conventional fields plus optional per-target override blocks keyed by target name.",
      properties: {
        target: { type: "string" },
        target_board: { type: "string" },
        version: { type: "string" },
        extensions: {
          type: "array",
          items: { type: "string" },
          description:
            "Ordered list of extension names included in this runtime. Names must match keys under top-level `extensions:`.",
        },
        packages: {
          type: "object",
          description:
            "Runtime-level packages (typically just `avocado-runtime: '*'`).",
          additionalProperties: true,
        },
        dependencies: {
          type: "object",
          additionalProperties: true,
        },
        stone_manifest: {
          type: "string",
          description:
            "Path (relative to project root) to a project-local stone manifest that overrides the BSP-shipped default. Used to override partition layouts (e.g. var partition size) and provisioning profile lists. Templating like `stone/{{ avocado.target }}/stone-{{ avocado.target }}.json` is supported.",
        },
        stone_include_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Directories to pass to `stone create -i ...` so the build can resolve project-local artifacts (e.g. bootfiles overrides) without copying them.",
        },
        signing: {
          type: "object",
          additionalProperties: true,
        },
        kernel: {
          oneOf: [{ type: "string" }, { type: "object" }],
          description:
            "Either a string reference to a top-level `kernel:` entry, or an inline kernel config.",
        },
        rootfs: {
          oneOf: [{ type: "string" }, { type: "object" }],
        },
        initramfs: {
          oneOf: [{ type: "string" }, { type: "object" }],
        },
        var: { $ref: "#/$defs/varConfig" },
        var_files: {
          type: "array",
          description:
            "Files copied from the project tree into the var partition image at build time. Each entry is `{source, dest}` (paths relative to project root and var-partition root respectively).",
          items: {
            type: "object",
            required: ["source", "dest"],
            properties: {
              source: { type: "string" },
              dest: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      // Per-target override blocks (e.g. `qemux86-64:`) appear as additional
      // properties with the same recursive shape. Leave open.
      additionalProperties: true,
    },

    extension: {
      type: "object",
      description:
        "An extension definition. All fields optional — different reference styles use different subsets.",
      properties: {
        source: {
          type: "object",
          required: ["type", "version"],
          properties: {
            type: { type: "string", enum: ["package"] },
            version: { type: "string" },
          },
          additionalProperties: true,
        },
        types: {
          type: "array",
          items: { type: "string", enum: ["sysext", "confext"] },
          minItems: 1,
          description:
            "Extension types. `sysext` extends /usr; `confext` extends /etc. App extensions are often both.",
        },
        version: {
          oneOf: [{ type: "string" }, { type: "number" }],
          description: "Extension version. Required for app-style extensions.",
        },
        summary: { type: "string" },
        overlay: {
          type: "string",
          description:
            "Path (relative to the extension dir) to a directory whose tree gets layered into the extension at the corresponding device paths.",
        },
        packages: {
          type: "object",
          description:
            "Packages to install into this extension. Values are either a version string ('*', '>=1.0') OR an object describing an in-tree compile artifact ({compile, install}).",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  compile: { type: "string" },
                  install: { type: "string" },
                },
                additionalProperties: true,
              },
            ],
          },
        },
        enable_services: {
          type: "array",
          items: { type: "string" },
          description: "systemd unit names to enable on boot.",
        },
        modprobe: {
          type: "array",
          items: { type: "string" },
          description:
            "Kernel modules to modprobe on boot via /etc/modules-load.d.",
        },
        on_merge: {
          type: "array",
          items: { type: "string" },
          description:
            "Shell commands run on the device when this extension is merged into the live image (first boot, sysext refresh, or `avocado deploy`).",
        },
        on_unmerge: {
          type: "array",
          items: { type: "string" },
          description: "Shell commands run when the extension is unmerged.",
        },
        docker_images: {
          type: "array",
          description:
            "Container images to pre-pull at `avocado build` time and seed into /var/lib/docker. Images are pulled for the target architecture by an ephemeral dockerd inside the SDK container.",
          items: {
            type: "object",
            required: ["image", "tag"],
            properties: {
              image: { type: "string" },
              tag: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        var_files: {
          type: "array",
          items: { type: "string" },
          description:
            "Glob patterns excluded from the read-only sysext image (so runtime-mutable paths like `var/lib/docker/**` aren't baked into the immutable extension).",
        },
        users: {
          type: "object",
          description:
            "[DEPRECATED] User accounts on extensions are deprecated and will be removed in a future release. Declare users in a top-level `permissions:` block and reference it from `rootfs.<name>.permissions` / `initramfs.<name>.permissions` instead. Each key is a username; the value is an attribute object.",
          additionalProperties: { type: "object" },
        },
        groups: {
          type: "object",
          description:
            "[DEPRECATED] Groups on extensions are deprecated and will be removed in a future release. Declare groups in a top-level `permissions:` block instead. Each key is a group name; the value is an attribute object.",
          additionalProperties: { type: "object" },
        },
        sdk: {
          type: "object",
          description:
            "Extension-scoped SDK dependencies — packages needed only to BUILD this extension, not to run it on the device.",
          properties: {
            packages: {
              type: "object",
              additionalProperties: true,
            },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },

    sdk: {
      type: "object",
      description:
        "SDK container configuration: which image to run, what args to pass docker, what host-side toolchain packages to install.",
      properties: {
        image: {
          type: "string",
          description:
            "Docker image reference (e.g. 'docker.io/avocadolinux/sdk:2024-edge'). Templating placeholders allowed.",
        },
        container_args: {
          type: "array",
          items: { type: "string" },
          description:
            "Args forwarded to `docker run` (e.g. ['--privileged', '-v /dev:/dev']).",
        },
        packages: {
          type: "object",
          description: "Packages to install into the SDK container.",
          additionalProperties: true,
        },
        compile: {
          type: "object",
          description:
            "Named SDK-side compile units. Each key is a unit name (often matching an extension package); value is the hook-script bundle.",
          additionalProperties: {
            type: "object",
            properties: {
              compile: { type: "string" },
              clean: { type: "string" },
              install: { type: "string" },
              packages: {
                type: "object",
                additionalProperties: true,
              },
              package: { type: "object", additionalProperties: true },
            },
            additionalProperties: true,
          },
        },
        repo_url: { type: "string" },
        repo_release: { type: "string" },
        disable_weak_dependencies: { type: "boolean" },
        host_uid: { type: "integer", minimum: 0 },
        host_gid: { type: "integer", minimum: 0 },
      },
      additionalProperties: true,
    },

    imageConfig: {
      type: "object",
      description:
        "Image (rootfs / initramfs) configuration. Drives the packages installed into a filesystem image plus the filesystem format.",
      properties: {
        packages: {
          type: "object",
          additionalProperties: true,
        },
        filesystem: {
          type: "string",
          description:
            "Output filesystem (e.g. 'erofs-lz4' for rootfs, 'cpio.zst' for initramfs).",
        },
        overlay: {
          description:
            "Overlay tree merged into the image. String path or structured value.",
        },
        image: {
          description:
            "Image-builder backend args. Format depends on filesystem.",
        },
        post_install: {
          type: "string",
          description:
            "Project-relative path to a post-install hook script run after package install + overlay and before mkfs.",
        },
        permissions: {
          oneOf: [{ type: "string" }, { $ref: "#/$defs/permissionsConfig" }],
          description:
            "Either a string reference to a top-level `permissions.<name>` entry, or an inline permissions block. When set, users/groups are baked into this image's /etc/passwd, /etc/shadow, /etc/group at build time. Omit to leave the base packages' generic identity files untouched.",
        },
      },
      additionalProperties: true,
    },

    permissionsConfig: {
      type: "object",
      description:
        "Users and groups to provision into a rootfs or initramfs image at build time. Referenced by name from `rootfs.<name>.permissions` / `initramfs.<name>.permissions`, or defined inline at the same location.",
      properties: {
        users: {
          type: "object",
          description:
            "User accounts. Each key is a username; each value is an object accepting `password`, `uid`, `gid`, `gecos`, `home`, `shell`, `groups`, `system`, `disabled`, and shadow-aging attributes (`last_change`, `min_days`, `max_days`, `warn_days`, `inactive_days`, `expire_date`).",
          additionalProperties: { type: "object" },
        },
        groups: {
          type: "object",
          description:
            "Group definitions. Each key is a group name; each value is an object accepting `gid`, `password`, `members`, `admins`, `system`.",
          additionalProperties: { type: "object" },
        },
      },
      additionalProperties: false,
    },

    kernelConfig: {
      type: "object",
      description:
        "Kernel definition. Pick one of: `package:` (pull a prebuilt kernel package), `version:` (constrain the version), or `compile:` + `install:` (build from source).",
      properties: {
        package: { type: "string" },
        version: { type: "string" },
        compile: { type: "string" },
        install: { type: "string" },
        image: {
          description: "Image-builder args for the kernel image.",
        },
      },
      additionalProperties: true,
    },

    provisionProfile: {
      type: "object",
      description:
        "Named provisioning profile. Tweaks the container args / state-file path used when `avocado provision -P <name>` runs.",
      properties: {
        container_args: {
          type: "array",
          items: { type: "string" },
        },
        state_file: { type: "string" },
      },
      additionalProperties: true,
    },

    varConfig: {
      type: "object",
      description:
        "Var-partition tuning: btrfs compression policy and named subvolumes.",
      properties: {
        compression: { type: "string" },
        subvolumes: {
          type: "object",
          description:
            "Named btrfs subvolumes carved out of /var (e.g. `lib/docker` to enable docker storage isolation).",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
};

export const BUNDLED_SCHEMA_VERSION = "0.2.0-mcp-bundled";
export const BUNDLED_SCHEMA_SOURCE =
  "bundled with avocado-os-mcp-server (derived from avocado-cli/src/utils/config.rs)";
