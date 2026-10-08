/**
 * Resolve the package feed a project is configured for, mirroring
 * avocado-cli's precedence so the MCP searches the SAME feed that
 * `avocado install` will resolve against.
 *
 * Every dnf baseurl the CLI builds is `${repoUrl}/${releasever}/...`
 * (see avocado-cli `src/utils/config.rs` and `src/utils/snapshot.rs`).
 *
 *   repo URL:   AVOCADO_REPO_URL > AVOCADO_SDK_REPO_URL (legacy)
 *               > distro.repo.url > repos.<distro>.url > sdk.repo_url (legacy)
 *               > https://repo.avocadolinux.org
 *   releasever: AVOCADO_RELEASEVER > AVOCADO_SDK_REPO_RELEASE (legacy)
 *               > distro.repo.releasever > repos.<distro>.releasever
 *               > repos.<distro>.{release}/{channel} > sdk.repo_release (legacy)
 *               > `{release}/{channel}` (snapshot-pinned when the lock
 *                 file records a matching `repo-snapshot` for the target)
 *   release:    AVOCADO_DISTRO_RELEASE > distro.release (alias distro.version)
 *   channel:    AVOCADO_DISTRO_CHANNEL > distro.channel
 *   CA:         AVOCADO_REPO_CA > distro.repo.ca > repos.<distro>.ca
 *   insecure:   AVOCADO_REPO_INSECURE (1/true/yes) > distro.repo.tls_verify == false
 *               > repos.<distro>.tls_verify == false
 *
 * `<distro>` is the `repos:` entry the distro feed uses: the name in a string
 * `distro.repo`, or `avocado` when `distro.repo` is absent. Other `repos:`
 * entries are enabled only when `distro.feeds` lists them (see
 * `resolveNamedFeeds`, which mirrors avocado-cli `src/utils/feeds.rs`).
 *
 * Explicit tool arguments (`repoUrl`, `release`, `channel`) sit above all of
 * these — they're a deliberate "look at a different feed" request.
 *
 * `distro` is read from the main avocado.yaml only (the CLI never takes it
 * from composed extension configs). `{{ env.X }}` and `{{ config.a.b }}`
 * templates in the fields we read are interpolated; anything else is left
 * as-is and reported in `notes`.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import {
  DISTRO_FEED_NAME,
  redactUrl,
  validateRepoUrl,
  type ExtraFeed,
  type FeedSpec,
  type NotChecked,
} from "./repo-client.js";

export const DEFAULT_REPO_URL = "https://repo.avocadolinux.org";
export const DEFAULT_RELEASE = "2024";
export const DEFAULT_CHANNEL = "edge";

/** avocado-cli lock files, newest first (`src/utils/lockfile.rs`). */
const LOCKFILE_PATHS = ["avocado.lock", join(".avocado", "lock.json")];

/**
 * Feed stages that install target packages into extensions and runtimes.
 * A feed scoped only to `sdk`, `rootfs` or `initramfs` never serves them.
 */
const PACKAGE_STAGES = ["ext", "runtime"];

/** dnf priority step between `distro.feeds` entries (avocado-cli). */
const PRIORITY_STEP = 10;

export interface FeedOverrides {
  repoUrl?: string;
  release?: string;
  channel?: string;
}

export interface RepoSnapshotPin {
  release: string;
  channel: string;
  snapshot: string;
}

/** One feed in the project's feed set, for reporting. */
export interface FeedEntry {
  name: string;
  kind: "distro" | "url" | "path" | "org";
  /** dnf priority. Lower wins. */
  priority: number;
  /** Redacted URL, the path as written, or `org:<org>`. */
  location: string;
  stages?: string[];
  /**
   * `queried`: the MCP reads it. `not-checked`: enabled, but the MCP can't
   * read it. `excluded`: `targets:` or `stages:` keep it out of target
   * package installs.
   */
  status: "queried" | "not-checked" | "excluded";
  reason?: string;
}

export interface ResolvedFeed extends FeedSpec {
  /** Configured feed year / channel, when known. */
  release?: string;
  channel?: string;
  /** Snapshot id when the lock file pins this target. */
  snapshot?: string;
  /** Human-readable provenance for each resolved value. */
  sources: {
    repoUrl: string;
    releasever: string;
    release?: string;
    channel?: string;
    ca?: string;
    insecure?: string;
  };
  /** Warnings the caller should surface verbatim. */
  notes: string[];
  /** avocado.yaml path the values came from, if any. */
  configPath?: string;
  /**
   * The project's feed set for this target, when it declares `repos:`,
   * `distro.feeds` or a named `distro.repo`.
   */
  feeds?: FeedEntry[];
}

export interface ResolveInput {
  /** Parsed avocado.yaml (main config). */
  config?: unknown;
  /** Parsed `.avocado/lock.json`. */
  lock?: unknown;
  env?: Record<string, string | undefined>;
  overrides?: FeedOverrides;
  /** Target to apply a lock-file snapshot pin for. */
  target?: string;
  /** Directory relative CA paths resolve against. */
  baseDir?: string;
  /** `src_dir`, or the config dir. `repos:` paths resolve against it. */
  projectRoot?: string;
  /** Resolve `repos:` feeds too (needs `target`). Default true. */
  named?: boolean;
  configPath?: string;
  /** Label for config-derived sources, e.g. "avocado.yaml". */
  configLabel?: string;
}

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Obj)
    : undefined;
}

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    const o = asObj(cur);
    if (!o) return undefined;
    cur = o[k];
  }
  return cur;
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Interpolate the subset of CLI templates we can evaluate outside the CLI.
 * `env.X` → env value (empty when unset, like the CLI); `config.a.b` → main
 * config value; `avocado.distro.{version,release,channel}` → main config
 * distro value. Anything else is left in place and reported.
 */
function interpolate(
  value: string,
  config: unknown,
  env: Record<string, string | undefined>,
  field: string,
  notes: string[],
): string {
  let out = value;
  for (let pass = 0; pass < 10 && TEMPLATE_RE.test(out); pass++) {
    TEMPLATE_RE.lastIndex = 0;
    const before = out;
    out = out.replace(TEMPLATE_RE, (whole, expr: string) => {
      const [ns, ...rest] = expr.split(".");
      if (ns === "env" && rest.length === 1) return env[rest[0]] ?? "";
      if (ns === "config" && rest.length > 0) {
        const v = getPath(config, rest);
        if (typeof v === "string" || typeof v === "number") return String(v);
      }
      if (ns === "avocado" && rest[0] === "distro" && rest.length === 2) {
        const key = rest[1] === "version" ? "release" : rest[1];
        const v =
          getPath(config, ["distro", key]) ??
          (key === "release"
            ? getPath(config, ["distro", "version"])
            : undefined);
        if (typeof v === "string" || typeof v === "number") return String(v);
      }
      notes.push(
        `\`${field}\` uses template \`${whole}\`, which the MCP can't evaluate — the value below may not match what the CLI resolves.`,
      );
      return whole;
    });
    if (out === before) break;
  }
  TEMPLATE_RE.lastIndex = 0;
  return out;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v !== "" ? v : undefined;
}

/**
 * Pure resolver — no I/O. Mirrors the CLI precedence documented at the top
 * of this file.
 */
export function resolveFeed(input: ResolveInput): ResolvedFeed {
  const env = input.env ?? {};
  const ov = input.overrides ?? {};
  const cfg = input.config;
  const label = input.configLabel ?? "avocado.yaml";
  const notes: string[] = [];

  const cfgString = (path: string[]): string | undefined => {
    const raw = getPath(cfg, path);
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string" && typeof raw !== "number") return undefined;
    return interpolate(String(raw), cfg, env, path.join("."), notes);
  };

  // The distro feed's `repos:` entry, as in avocado-cli `distro_feed_def`:
  // a string `distro.repo` names it, no `distro.repo` means `avocado`, and an
  // inline block means there is none.
  const distroRef = getPath(cfg, ["distro", "repo"]);
  const distroName =
    typeof distroRef === "string" ? distroRef : DISTRO_FEED_NAME;
  const hasDistroDef = asObj(distroRef) === undefined;
  const defString = (k: string): string | undefined =>
    hasDistroDef ? cfgString(["repos", distroName, k]) : undefined;
  const defLabel = (k: string) => `${label} repos.${distroName}.${k}`;

  // ── repo URL ─────────────────────────────────────────────────────────
  let baseUrl: string;
  let repoUrlSrc: string;
  const cfgRepoUrl = cfgString(["distro", "repo", "url"]);
  const defRepoUrl = defString("url");
  const cfgSdkRepoUrl = cfgString(["sdk", "repo_url"]);
  if (ov.repoUrl) {
    baseUrl = ov.repoUrl;
    repoUrlSrc = "tool argument `repoUrl`";
  } else if (env.AVOCADO_REPO_URL !== undefined) {
    baseUrl = env.AVOCADO_REPO_URL;
    repoUrlSrc = "env AVOCADO_REPO_URL";
  } else if (env.AVOCADO_SDK_REPO_URL !== undefined) {
    baseUrl = env.AVOCADO_SDK_REPO_URL;
    repoUrlSrc = "env AVOCADO_SDK_REPO_URL (legacy)";
  } else if (cfgRepoUrl !== undefined) {
    baseUrl = cfgRepoUrl;
    repoUrlSrc = `${label} distro.repo.url`;
  } else if (defRepoUrl !== undefined) {
    baseUrl = defRepoUrl;
    repoUrlSrc = defLabel("url");
  } else if (cfgSdkRepoUrl !== undefined) {
    baseUrl = cfgSdkRepoUrl;
    repoUrlSrc = `${label} sdk.repo_url (legacy)`;
  } else {
    baseUrl = DEFAULT_REPO_URL;
    repoUrlSrc = "default";
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  // ── release / channel ────────────────────────────────────────────────
  let release: string | undefined;
  let releaseSrc: string | undefined;
  if (ov.release) {
    release = ov.release;
    releaseSrc = "tool argument `release`";
  } else if (env.AVOCADO_DISTRO_RELEASE !== undefined) {
    release = env.AVOCADO_DISTRO_RELEASE;
    releaseSrc = "env AVOCADO_DISTRO_RELEASE";
  } else {
    const r = cfgString(["distro", "release"]);
    const v = r === undefined ? cfgString(["distro", "version"]) : undefined;
    if (r !== undefined) {
      release = r;
      releaseSrc = `${label} distro.release`;
    } else if (v !== undefined) {
      release = v;
      releaseSrc = `${label} distro.version`;
    }
  }

  let channel: string | undefined;
  let channelSrc: string | undefined;
  if (ov.channel) {
    channel = ov.channel;
    channelSrc = "tool argument `channel`";
  } else if (env.AVOCADO_DISTRO_CHANNEL !== undefined) {
    channel = env.AVOCADO_DISTRO_CHANNEL;
    channelSrc = "env AVOCADO_DISTRO_CHANNEL";
  } else {
    const c = cfgString(["distro", "channel"]);
    if (c !== undefined) {
      channel = c;
      channelSrc = `${label} distro.channel`;
    }
  }

  // ── releasever ───────────────────────────────────────────────────────
  let releasever: string | undefined;
  let releaseverSrc = "";
  let snapshot: string | undefined;
  const explicitStream = Boolean(ov.release || ov.channel);

  const cfgReleasever = cfgString(["distro", "repo", "releasever"]);
  const defRelease = defString("release");
  const defChannel = defString("channel");
  const defReleasever =
    defString("releasever") ??
    (defRelease && defChannel ? `${defRelease}/${defChannel}` : undefined);
  const cfgSdkRepoRelease = cfgString(["sdk", "repo_release"]);
  if (!explicitStream) {
    if (env.AVOCADO_RELEASEVER !== undefined) {
      releasever = env.AVOCADO_RELEASEVER;
      releaseverSrc = "env AVOCADO_RELEASEVER";
    } else if (env.AVOCADO_SDK_REPO_RELEASE !== undefined) {
      releasever = env.AVOCADO_SDK_REPO_RELEASE;
      releaseverSrc = "env AVOCADO_SDK_REPO_RELEASE (legacy)";
    } else if (cfgReleasever !== undefined) {
      releasever = cfgReleasever;
      releaseverSrc = `${label} distro.repo.releasever`;
    } else if (defReleasever !== undefined) {
      releasever = defReleasever;
      releaseverSrc = defLabel(
        getPath(cfg, ["repos", distroName, "releasever"]) !== undefined
          ? "releasever"
          : "release/channel",
      );
    } else if (cfgSdkRepoRelease !== undefined) {
      releasever = cfgSdkRepoRelease;
      releaseverSrc = `${label} sdk.repo_release (legacy)`;
    }
  }

  if (releasever === undefined) {
    if (explicitStream) {
      // Fill whichever half wasn't passed from config, then the default.
      const rvOverride =
        env.AVOCADO_RELEASEVER ??
        env.AVOCADO_SDK_REPO_RELEASE ??
        cfgReleasever ??
        defReleasever ??
        cfgSdkRepoRelease;
      const [rvRelease, rvChannel] = (rvOverride ?? "").split("/");
      if (!release && rvRelease) {
        release = rvRelease;
        releaseSrc = "parsed from configured releasever";
      }
      if (!channel && rvChannel) {
        channel = rvChannel;
        channelSrc = "parsed from configured releasever";
      }
      if (!release) {
        release = DEFAULT_RELEASE;
        releaseSrc = "default";
      }
      if (!channel) {
        channel = DEFAULT_CHANNEL;
        channelSrc = "default";
      }
      releasever = `${release}/${channel}`;
      releaseverSrc = "derived {release}/{channel}";
    } else if (release && channel) {
      releasever = `${release}/${channel}`;
      releaseverSrc = "derived {release}/{channel}";
      // Lock-file snapshot pin (CLI: snapshot::resolve_and_apply). Only
      // applies when releasever isn't explicitly overridden, which is the
      // branch we're in.
      if (input.target) {
        const pin = readPin(input.lock, input.target);
        if (pin) {
          if (pin.release === release && pin.channel === channel) {
            snapshot = pin.snapshot;
            releasever = `${release}/${channel}/snapshots/${pin.snapshot}`;
            releaseverSrc = `lock file snapshot pin for \`${input.target}\``;
          } else {
            notes.push(
              `Lock file pins \`${input.target}\` to a snapshot of ${pin.release}/${pin.channel}, but config names ${release}/${channel}. The CLI ignores that stale pin and tracks the live channel head (run \`avocado update\` to re-pin) — the MCP does the same.`,
            );
          }
        }
      }
    } else {
      const missing = [
        !release && "distro.release",
        !channel && "distro.channel",
      ]
        .filter(Boolean)
        .join(" and ");
      if (input.config !== undefined) {
        notes.push(
          `Config sets no ${missing}. The CLI then leaves releasever to the SDK image's VERSION_CODENAME, which the MCP can't see — assuming ${DEFAULT_RELEASE}/${DEFAULT_CHANNEL}. Set \`distro.release\` and \`distro.channel\` in avocado.yaml to make this exact.`,
        );
      }
      release = release ?? DEFAULT_RELEASE;
      releaseSrc = releaseSrc ?? "default";
      channel = channel ?? DEFAULT_CHANNEL;
      channelSrc = channelSrc ?? "default";
      releasever = `${release}/${channel}`;
      releaseverSrc =
        input.config === undefined ? "default (no project config)" : "default";
    }
  } else {
    // An explicit releasever wins over release/channel; recover them for
    // display when it has the usual `{release}/{channel}[/...]` shape.
    const [r, c] = releasever.split("/");
    if (r && c) {
      if (release !== r || channel !== c) {
        release = r;
        channel = c;
        releaseSrc = channelSrc = `parsed from releasever (${releaseverSrc})`;
      }
    }
    const snap = releasever.match(/\/snapshots\/([^/]+)$/);
    if (snap) snapshot = snap[1];
  }
  releasever = releasever.replace(/^\/+|\/+$/g, "");

  // ── TLS ──────────────────────────────────────────────────────────────
  let ca: string | undefined;
  let caSrc: string | undefined;
  const cfgCa = cfgString(["distro", "repo", "ca"]);
  const defCa = defString("ca");
  if (nonEmpty(env.AVOCADO_REPO_CA)) {
    ca = env.AVOCADO_REPO_CA;
    caSrc = "env AVOCADO_REPO_CA";
  } else if (cfgCa !== undefined) {
    ca = cfgCa;
    caSrc = `${label} distro.repo.ca`;
  } else if (defCa !== undefined) {
    ca = defCa;
    caSrc = defLabel("ca");
  }
  if (ca && !isAbsolute(ca) && input.baseDir) ca = resolve(input.baseDir, ca);

  let insecure = false;
  let insecureSrc: string | undefined;
  if (env.AVOCADO_REPO_INSECURE !== undefined) {
    insecure = ["1", "true", "yes"].includes(
      env.AVOCADO_REPO_INSECURE.toLowerCase(),
    );
    insecureSrc = "env AVOCADO_REPO_INSECURE";
  } else {
    const tv = getPath(cfg, ["distro", "repo", "tls_verify"]);
    const defTv = hasDistroDef
      ? getPath(cfg, ["repos", distroName, "tls_verify"])
      : undefined;
    if (tv === false) {
      insecure = true;
      insecureSrc = `${label} distro.repo.tls_verify: false`;
    } else if (tv === undefined && defTv === false) {
      insecure = true;
      insecureSrc = `${defLabel("tls_verify")}: false`;
    }
  }

  // Manifest (targets.json) lives at the live channel head; snapshots
  // mirror only the repo trees.
  const manifestPath = releasever.replace(/\/snapshots\/[^/]+$/, "");
  const tls = ca || insecure ? { ca, insecure } : undefined;

  const named =
    input.named !== false && input.target
      ? resolveNamedFeeds({
          config: cfg,
          env,
          target: input.target,
          distroName,
          distroReleasever: releasever,
          projectRoot: input.projectRoot,
          lock: input.lock,
          notes,
        })
      : undefined;
  if (named) {
    const distro = named.feeds.find((f) => f.kind === "distro");
    if (distro) distro.location = `${redactUrl(baseUrl)}/${releasever}`;
  }

  return {
    baseUrl,
    releasever,
    manifestPath,
    tls,
    name: distroName,
    priority: named?.distroPriority,
    extraFeeds: named?.extraFeeds,
    notChecked: named?.notChecked,
    feeds: named?.feeds,
    release,
    channel,
    snapshot,
    sources: {
      repoUrl: repoUrlSrc,
      releasever: releaseverSrc,
      release: releaseSrc,
      channel: channelSrc,
      ca: caSrc,
      insecure: insecureSrc,
    },
    notes,
    configPath: input.configPath,
  };
}

function readPin(lock: unknown, target: string): RepoSnapshotPin | undefined {
  const t = getPath(lock, ["targets", target, "repo-snapshot"]);
  const o = asObj(t);
  if (!o) return undefined;
  const { release, channel, snapshot } = o;
  if (
    typeof release === "string" &&
    typeof channel === "string" &&
    typeof snapshot === "string"
  ) {
    return { release, channel, snapshot };
  }
  return undefined;
}

interface NamedFeedsInput {
  config: unknown;
  env: Record<string, string | undefined>;
  target: string;
  distroName: string;
  /** Expands `$releasever` (already snapshot-pinned for this target). */
  distroReleasever: string;
  projectRoot?: string;
  lock: unknown;
  notes: string[];
}

/** Env vars a `{{ env.X }}` template reads that the MCP's env does not set. */
function unsetEnvVars(
  value: string,
  env: Record<string, string | undefined>,
): string[] {
  return [...value.matchAll(/\{\{\s*env\.([^}\s]+)\s*\}\}/g)]
    .map((m) => m[1])
    .filter((name) => env[name] === undefined);
}

/**
 * The project's feed set for one target, in dnf priority order. Mirrors
 * avocado-cli `ResolvedFeedSet::resolve`: `repos:` defines feeds,
 * `distro.feeds` enables and orders them, and the distro feed comes first
 * unless the list places it. Returns undefined when the project declares no
 * named feeds (the CLI's zero-cost path).
 *
 * The CLI also writes this set to `.avocado/feeds/<target>.json`. We resolve
 * from config instead: that file lacks CA paths, holds loopback URLs
 * rewritten for the container, and goes stale when avocado.yaml changes
 * before the next install. `repos:` only comes from the main config, so
 * config resolution sees the same inputs.
 */
function resolveNamedFeeds(input: NamedFeedsInput):
  | {
      feeds: FeedEntry[];
      extraFeeds: ExtraFeed[];
      notChecked: NotChecked[];
      distroPriority: number;
    }
  | undefined {
  const { config: cfg, env, target, distroName, notes } = input;
  const repos = asObj(getPath(cfg, ["repos"]));
  const list = getPath(cfg, ["distro", "feeds"]);
  if (!repos && list === undefined && distroName === DISTRO_FEED_NAME) {
    return undefined;
  }

  const order = Array.isArray(list)
    ? [...new Set(list.filter((n): n is string => typeof n === "string"))]
    : [];
  if (!order.includes(distroName)) order.unshift(distroName);

  const feeds: FeedEntry[] = [];
  const extraFeeds: ExtraFeed[] = [];
  const notChecked: NotChecked[] = [];
  let distroPriority = PRIORITY_STEP;

  order.forEach((name, i) => {
    const priority = PRIORITY_STEP * (i + 1);
    if (name === distroName) {
      distroPriority = priority;
      feeds.push({
        name,
        kind: "distro",
        priority,
        location: "",
        status: "queried",
      });
      return;
    }
    const def = asObj(repos?.[name]);
    if (!def) {
      notes.push(
        `\`distro.feeds\` lists \`${name}\`, but \`repos:\` does not define it. The CLI rejects this config.`,
      );
      return;
    }
    const field = (k: string): string | undefined => {
      const v = def[k];
      if (typeof v !== "string" && typeof v !== "number") return undefined;
      return interpolate(String(v), cfg, env, `repos.${name}.${k}`, notes);
    };
    const stages = Array.isArray(def.stages)
      ? def.stages.map(String)
      : undefined;
    const kind =
      def.org !== undefined ? "org" : def.path !== undefined ? "path" : "url";
    const entry: FeedEntry = {
      name,
      kind,
      priority,
      location:
        kind === "org"
          ? `org:${String(def.org)}`
          : kind === "path"
            ? String(def.path)
            : redactUrl(String(def.url ?? "")),
      stages,
      status: "queried",
    };
    feeds.push(entry);

    const skip = (status: FeedEntry["status"], reason: string) => {
      entry.status = status;
      entry.reason = reason;
      if (status === "not-checked") notChecked.push({ feed: name, reason });
    };

    if (
      Array.isArray(def.targets) &&
      !def.targets.map(String).includes(target)
    ) {
      return skip(
        "excluded",
        `\`targets:\` does not list \`${target}\`, so the CLI does not enable it for this target.`,
      );
    }
    if (stages && !stages.some((st) => PACKAGE_STAGES.includes(st))) {
      return skip(
        "excluded",
        `\`stages: [${stages.join(", ")}]\` does not include \`ext\` or \`runtime\`, so extension and runtime installs do not use it.`,
      );
    }
    if (kind === "org") {
      return skip(
        "not-checked",
        `private Connect feed (\`org: ${String(def.org)}\`). The MCP does not use Connect credentials, so it cannot read it. The CLI reads it after \`avocado login\`.`,
      );
    }
    if (kind === "path") {
      const p = field("path") ?? "";
      if (!isAbsolute(p) && !input.projectRoot) {
        return skip(
          "not-checked",
          "a relative `path:` needs `projectDir` to resolve.",
        );
      }
      extraFeeds.push({
        name,
        priority,
        path: input.projectRoot ? resolve(input.projectRoot, p) : p,
      });
      return;
    }

    // url feed.
    const rawUrl = typeof def.url === "string" ? def.url : "";
    let url: string | undefined;
    const unset = unsetEnvVars(rawUrl, env);
    if (unset.length > 0) {
      // The lock records the URL the CLI expanded at install time.
      const locked = (
        getPath(input.lock, ["targets", target, "feeds"]) as
          | unknown[]
          | undefined
      )
        ?.map(asObj)
        .find((f) => f?.name === name)?.url;
      if (typeof locked !== "string") {
        return skip(
          "not-checked",
          `\`url\` reads \`${unset.map((v) => `env.${v}`).join("`, `")}\`, which is not set in the MCP server's environment.`,
        );
      }
      url = locked;
    } else {
      url = field("url") ?? "";
      if (/\{\{/.test(url)) {
        return skip(
          "not-checked",
          "`url` uses a template the MCP can't evaluate.",
        );
      }
      const releasever =
        field("releasever") ??
        (def.release !== undefined && def.channel !== undefined
          ? `${field("release")}/${field("channel")}`
          : input.distroReleasever);
      url = url
        .replaceAll("$target", target)
        .replaceAll("$releasever", releasever);
    }
    entry.location = redactUrl(url);
    try {
      url = validateRepoUrl(url);
    } catch (e) {
      return skip("not-checked", (e as Error).message);
    }

    const username = field("username");
    const password = field("password");
    if (username && !password) {
      return skip(
        "not-checked",
        "`username` is set but `password` is empty. An unset env var becomes an empty string.",
      );
    }
    const ca = field("ca");
    const insecure = def.tls_verify === false;
    extraFeeds.push({
      name,
      priority,
      url,
      tls:
        ca || insecure
          ? {
              ca: ca && input.projectRoot ? resolve(input.projectRoot, ca) : ca,
              insecure,
            }
          : undefined,
      auth: username && password ? { username, password } : undefined,
    });
  });

  return { feeds, extraFeeds, notChecked, distroPriority };
}

export interface FeedContextInput extends FeedOverrides {
  /** Project directory, or a path to its avocado.yaml. */
  projectDir?: string;
  /** avocado.yaml content (used instead of reading projectDir/avocado.yaml). */
  yaml?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Feed resolution bound to one project: loads avocado.yaml + lock file
 * once, then hands out per-target feeds (snapshot pins are per target).
 */
export class FeedContext {
  private constructor(
    private readonly config: unknown,
    private readonly lock: unknown,
    private readonly env: Record<string, string | undefined>,
    private readonly overrides: FeedOverrides,
    private readonly baseDir: string | undefined,
    private readonly configPath: string | undefined,
    private readonly loadNotes: string[],
    private readonly projectRoot: string | undefined,
    private readonly named = true,
  ) {}

  static load(input: FeedContextInput = {}): FeedContext {
    const env = input.env ?? process.env;
    const notes: string[] = [];
    let config: unknown;
    let configPath: string | undefined;
    let configDir: string | undefined;

    if (input.projectDir) {
      const p = resolve(input.projectDir);
      if (existsSync(p) && statSync(p).isFile()) {
        configPath = p;
        configDir = dirname(p);
      } else {
        configDir = p;
        configPath = join(p, "avocado.yaml");
      }
    }

    let text = input.yaml;
    if (text === undefined && configPath) {
      if (existsSync(configPath)) {
        text = readFileSync(configPath, "utf-8");
      } else {
        notes.push(
          `No avocado.yaml at \`${configPath}\` — falling back to env/defaults.`,
        );
        configPath = undefined;
      }
    }
    if (text !== undefined) {
      try {
        config = parseYaml(text) ?? {};
      } catch (e) {
        notes.push(
          `Could not parse avocado.yaml (${(e as Error).message}) — falling back to env/defaults.`,
        );
      }
    }

    // Lock file: `{src_dir or config dir}/avocado.lock`, else the legacy
    // `.avocado/lock.json`. The v8 lock keeps `repo-snapshot` where v7 had it.
    let lock: unknown;
    let projectRoot: string | undefined;
    if (configDir) {
      const srcDir = getPath(config, ["src_dir"]);
      projectRoot =
        typeof srcDir === "string" && srcDir
          ? resolve(configDir, srcDir)
          : configDir;
      const lockPath = LOCKFILE_PATHS.map((p) => join(projectRoot!, p)).find(
        (p) => existsSync(p),
      );
      if (lockPath) {
        try {
          lock = JSON.parse(readFileSync(lockPath, "utf-8"));
        } catch (e) {
          notes.push(
            `Could not parse \`${lockPath}\` (${(e as Error).message}) — ignoring snapshot pins.`,
          );
        }
      }
    }

    return new FeedContext(
      config,
      lock,
      env,
      {
        repoUrl: input.repoUrl,
        release: input.release,
        channel: input.channel,
      },
      configDir,
      configPath,
      notes,
      projectRoot,
    );
  }

  /** True when an avocado.yaml was loaded. */
  get hasProjectConfig(): boolean {
    return this.config !== undefined;
  }

  private resolve(target?: string, overrides?: FeedOverrides): ResolvedFeed {
    const feed = resolveFeed({
      config: this.config,
      lock: this.lock,
      env: this.env,
      overrides: { ...this.overrides, ...overrides },
      target,
      baseDir: this.baseDir,
      projectRoot: this.projectRoot,
      named: this.named,
      configPath: this.configPath,
    });
    feed.notes.unshift(...this.loadNotes);
    return feed;
  }

  /** Feed with no per-target snapshot applied — use for targets.json. */
  get base(): ResolvedFeed {
    return this.resolve();
  }

  forTarget(target: string): ResolvedFeed {
    return this.resolve(target);
  }

  /**
   * Same project config, but a different release/channel stream. Only the
   * distro feed is probed there: the project's `repos:` feeds don't change
   * with the stream.
   */
  withStream(release: string, channel: string): FeedContext {
    return new FeedContext(
      this.config,
      this.lock,
      this.env,
      { ...this.overrides, release, channel },
      this.baseDir,
      this.configPath,
      this.loadNotes,
      this.projectRoot,
      false,
    );
  }

  /** Markdown block describing the effective feed and where it came from. */
  describe(targets: string[] = []): string {
    return describeFeeds(
      this.base,
      targets.map((t) => this.forTarget(t)),
      targets,
    );
  }

  structured(targets: string[] = []): FeedSummary {
    const base = this.base;
    const feeds = targets.flatMap((target) =>
      (this.forTarget(target).feeds ?? []).map((f) => ({ target, ...f })),
    );
    return {
      repoUrl: redactUrl(base.baseUrl),
      repoUrlOverridden: repoUrlOverridden(base),
      defaultRepoUrl: DEFAULT_REPO_URL,
      releasever: base.releasever,
      release: base.release,
      channel: base.channel,
      configPath: base.configPath,
      sources: base.sources,
      snapshots: Object.fromEntries(
        targets
          .map((t) => [t, this.forTarget(t).snapshot] as const)
          .filter(([, s]) => s !== undefined),
      ) as Record<string, string>,
      notes: dedupNotes([
        ...base.notes,
        ...targets.flatMap((t) => this.forTarget(t).notes),
      ]),
      ...(feeds.length > 0 ? { feeds } : {}),
    };
  }
}

export interface FeedSummary {
  repoUrl: string;
  /** True when the repo URL came from anything but the built-in default. */
  repoUrlOverridden: boolean;
  defaultRepoUrl: string;
  releasever: string;
  release?: string;
  channel?: string;
  configPath?: string;
  sources: ResolvedFeed["sources"];
  snapshots: Record<string, string>;
  notes: string[];
  /** Per-target feed set, when the project declares named feeds. */
  feeds?: (FeedEntry & { target: string })[];
}

/**
 * Whether the repo URL was set by a tool argument, env var or avocado.yaml
 * rather than falling back to the default. Judged by where the value came
 * from, not by comparing URLs: an override that happens to equal the default
 * is still an override the user configured.
 */
export function repoUrlOverridden(feed: ResolvedFeed): boolean {
  return feed.sources.repoUrl !== "default";
}

function dedupNotes(notes: string[]): string[] {
  return [...new Set(notes)];
}

export function feedUrl(feed: FeedSpec, path = feed.releasever): string {
  return `${redactUrl(feed.baseUrl)}/${path}`;
}

/** Where targets.json is fetched from — for error messages. */
export function feedFetchLabel(feed: FeedSpec): string {
  return feedUrl(feed, feed.manifestPath);
}

function describeFeeds(
  base: ResolvedFeed,
  perTarget: ResolvedFeed[],
  targets: string[],
): string {
  const s = base.sources;
  let out = `**Feed:** \`${feedUrl(base)}\``;
  if (s.releasever.startsWith("derived")) {
    out += ` — release \`${base.release}\` (${s.release}), channel \`${base.channel}\` (${s.channel})`;
  } else {
    out += ` — releasever from ${s.releasever}`;
  }
  if (base.configPath) out += `; config \`${base.configPath}\``;
  out += `\n`;
  out += repoUrlOverridden(base)
    ? `**Repo URL:** \`${redactUrl(base.baseUrl)}\` — **overridden** by ${s.repoUrl} (default is \`${DEFAULT_REPO_URL}\`)\n`
    : `**Repo URL:** \`${redactUrl(base.baseUrl)}\` (default, not overridden)\n`;
  perTarget.forEach((f, i) => {
    if (f.snapshot && f.releasever !== base.releasever) {
      out += `**Snapshot pin:** \`${targets[i]}\` → \`${feedUrl(f)}\` (${f.sources.releasever} — matches what \`avocado install\` resolves)\n`;
    }
  });
  if (base.tls) {
    const bits = [
      base.tls.ca && `CA \`${base.tls.ca}\` (${s.ca})`,
      base.tls.insecure && `TLS verification OFF (${s.insecure})`,
    ].filter(Boolean);
    out += `**TLS:** ${bits.join("; ")}\n`;
  }
  perTarget.forEach((f, i) => {
    if (!f.feeds) return;
    out += `**Feeds for \`${targets[i]}\`** (dnf priority order, first wins):\n`;
    for (const e of f.feeds) {
      out += `- \`${e.name}\` (${e.kind}) \`${e.location}\``;
      if (e.status !== "queried") out += `: **${e.status}**. ${e.reason}`;
      out += `\n`;
    }
  });
  const notes = dedupNotes([
    ...base.notes,
    ...perTarget.flatMap((f) => f.notes),
  ]);
  for (const n of notes) out += `> ⚠️ ${n}\n`;
  if (
    !base.configPath &&
    s.repoUrl === "default" &&
    s.releasever.startsWith("default")
  ) {
    out += `_No project given — using the default feed. Pass \`projectDir\` to search the feed the project is configured for._\n`;
  }
  return out;
}
