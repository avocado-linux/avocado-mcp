/**
 * Reference catalog + content fetcher.
 *
 * Source of truth: github.com/avocado-linux/references (public). Every
 * reference is a top-level directory in that repo, structured as:
 *
 *   <slug>/
 *     README.md
 *     getting_started.md
 *     avocado.yaml
 *     app/
 *       <app source — e.g. package.json, server.js>
 *       overlay/
 *         <root-fs-style tree of files baked into the extension>
 *     app-clean.sh
 *     app-compile.sh
 *     app-install.sh
 *     icon.png
 *
 * The CATALOG below is hardcoded metadata (title, language, tags) so the LLM
 * can browse and search without hitting GitHub. Actual content is fetched on
 * demand from raw.githubusercontent.com.
 */

const REPO_OWNER = "avocado-linux";
const REPO_NAME = "references";
const REPO_REF = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}`;
const API_TREE_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_REF}?recursive=1`;
const SOURCE_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${REPO_REF}`;

const USER_AGENT = "avocado-mcp-server";
const TREE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FILE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB per file safety cap

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export interface ReferenceEntry {
  slug: string;
  title: string;
  language: string;
  /** one-liner shown in lists */
  summary: string;
  /** targets the reference is known to work on; empty means generic */
  hardware: string[];
  /** keywords for search */
  tags: string[];
}

export interface ReferenceProject {
  entry: ReferenceEntry;
  /** Source URL on github.com for the reference's root directory */
  sourceUrl: string;
  /** All paths under <slug>/, sorted */
  files: string[];
  avocadoYaml: string | null;
  readme: string | null;
  gettingStarted: string | null;
  /** Quick summary of build hooks present (app-clean.sh, app-compile.sh, …) */
  buildHooks: string[];
  /** All paths under <slug>/app/overlay/, relative to overlay/ */
  overlayPaths: string[];
}

export const CATALOG: ReferenceEntry[] = [
  {
    slug: "c-gpio",
    title: "C GPIO",
    language: "C",
    summary: "Toggle GPIO from a C program built against the Avocado SDK.",
    hardware: ["raspberrypi5", "raspberrypi4"],
    tags: ["gpio", "c", "hardware-control"],
  },
  {
    slug: "cpp-tui-dashboard",
    title: "C++ TUI dashboard",
    language: "C++",
    summary: "Terminal UI dashboard in C++ using ncurses.",
    hardware: [],
    tags: ["c++", "tui", "ncurses", "dashboard"],
  },
  {
    slug: "dev",
    title: "Dev runtime walkthrough",
    language: "n/a",
    summary:
      "Tour of the dev runtime: SSH access, debugging tools, hardware-in-the-loop iteration.",
    hardware: [],
    tags: ["dev", "ssh", "debug", "getting-started"],
  },
  {
    slug: "elixir-phoenix",
    title: "Elixir Phoenix",
    language: "Elixir",
    summary: "Phoenix web app on Avocado OS with hot code reload.",
    hardware: [],
    tags: ["elixir", "phoenix", "beam", "web"],
  },
  {
    slug: "icam-540",
    title: "Advantech ICAM-540 AI camera",
    language: "Python",
    summary: "Vision pipeline on the Advantech ICAM-540 (Jetson Orin NX).",
    hardware: ["icam-540"],
    tags: ["vision", "ai", "jetson", "camera", "deepstream"],
  },
  {
    slug: "java-hello",
    title: "Java hello world",
    language: "Java",
    summary: "Minimal Java app + JRE extension on Avocado OS.",
    hardware: [],
    tags: ["java", "jvm", "hello-world"],
  },
  {
    slug: "linux-custom-kernel",
    title: "Custom Linux kernel",
    language: "n/a",
    summary: "Build and ship a custom Linux kernel with your project.",
    hardware: [],
    tags: ["kernel", "linux", "advanced"],
  },
  {
    slug: "nodejs-dashboard",
    title: "Node.js dashboard",
    language: "Node.js",
    summary: "Server-rendered Node.js dashboard with WebSocket telemetry.",
    hardware: [],
    tags: ["node", "javascript", "dashboard", "websocket"],
  },
  {
    slug: "python-flask",
    title: "Python Flask",
    language: "Python",
    summary: "Flask web app served from the device.",
    hardware: [],
    tags: ["python", "flask", "web"],
  },
  {
    slug: "python-gstreamer-yolo",
    title: "Python GStreamer + YOLO",
    language: "Python",
    summary:
      "Real-time object detection with GStreamer ingest and YOLO inference.",
    hardware: ["jetson-orin-nano-devkit", "jetson-agx-orin-devkit", "icam-540"],
    tags: ["python", "gstreamer", "yolo", "vision", "ai"],
  },
  {
    slug: "python-mqtt",
    title: "Python MQTT",
    language: "Python",
    summary: "Publish/subscribe MQTT client in Python.",
    hardware: [],
    tags: ["python", "mqtt", "iot", "messaging"],
  },
  {
    slug: "python-whisper",
    title: "Python Whisper speech-to-text",
    language: "Python",
    summary: "On-device speech transcription with Whisper.",
    hardware: [],
    tags: ["python", "whisper", "audio", "ai", "speech"],
  },
  {
    slug: "qemu-quickstart",
    title: "QEMU quickstart",
    language: "n/a",
    summary: "Build and boot Avocado OS in QEMU — no hardware required.",
    hardware: ["qemuarm64", "qemux86-64"],
    tags: ["qemu", "virtual", "getting-started"],
  },
  {
    slug: "react-dashboard",
    title: "React dashboard",
    language: "JavaScript",
    summary: "React SPA served by an embedded HTTP server.",
    hardware: [],
    tags: ["react", "javascript", "dashboard", "spa"],
  },
  {
    slug: "rubicon",
    title: "Rubicon orchestrator",
    language: "Python",
    summary:
      "Reference orchestrator binary — used for self-test and on-device validation flows.",
    hardware: [],
    tags: ["python", "orchestration", "testing"],
  },
  {
    slug: "rust-vitals",
    title: "Rust vitals telemetry",
    language: "Rust",
    summary: "System telemetry collector in Rust, exposed over HTTP.",
    hardware: [],
    tags: ["rust", "telemetry", "http", "metrics"],
  },
  {
    slug: "shell-heartbeat",
    title: "Shell heartbeat",
    language: "Shell",
    summary: "Tiny POSIX-shell heartbeat service for liveness checks.",
    hardware: [],
    tags: ["shell", "bash", "heartbeat", "minimal"],
  },
  {
    slug: "webkit-ui",
    title: "WebKit UI",
    language: "JavaScript",
    summary: "Fullscreen WebKit-based HMI surface for kiosks/HMIs.",
    hardware: [],
    tags: ["webkit", "ui", "kiosk", "hmi"],
  },
];

export function listReferences(): ReferenceEntry[] {
  return [...CATALOG].sort((a, b) => a.title.localeCompare(b.title));
}

export function searchReferences(
  query: string,
  target?: string,
): ReferenceEntry[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/)
    .filter((t) => t.length > 0);

  type Scored = { entry: ReferenceEntry; score: number };
  const scored: Scored[] = [];
  for (const r of CATALOG) {
    if (target && r.hardware.length > 0 && !r.hardware.includes(target)) {
      continue;
    }
    if (tokens.length === 0) {
      scored.push({ entry: r, score: 0 });
      continue;
    }
    const haystack = [r.slug, r.title, r.language, r.summary, ...r.tags]
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score++;
    }
    // Exact slug match is the strongest signal.
    if (tokens.includes(r.slug)) score += 10;
    if (score > 0) scored.push({ entry: r, score });
  }

  return scored
    .sort(
      (a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title),
    )
    .map((s) => s.entry);
}

export function getReferenceEntry(slug: string): ReferenceEntry | undefined {
  return CATALOG.find((r) => r.slug === slug);
}

export function referenceUrl(slug: string): string {
  return `${SOURCE_BASE}/${slug}`;
}

// ----- tree + file fetching -----

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

let treeCache: { entries: TreeEntry[]; expiresAt: number } | null = null;
const fileCache = new Map<string, { content: string; expiresAt: number }>();

async function fetchRepoTree(): Promise<TreeEntry[]> {
  const now = Date.now();
  if (treeCache && now < treeCache.expiresAt) return treeCache.entries;
  const res = await fetch(API_TREE_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub trees API: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    tree: { path: string; type: string; size?: number }[];
    truncated?: boolean;
  };
  if (data.truncated) {
    // Hasn't happened to date — the repo is small. Surface it loudly if it does.
    console.error(
      "[WARN] github trees API returned truncated:true; reference listings may be incomplete",
    );
  }
  const entries: TreeEntry[] = data.tree
    .filter((t) => t.type === "blob" || t.type === "tree")
    .map((t) => ({
      path: t.path,
      type: t.type as "blob" | "tree",
      size: t.size,
    }));
  treeCache = { entries, expiresAt: now + TREE_CACHE_TTL_MS };
  return entries;
}

/**
 * Return all paths under <slug>/, sorted. Paths are stripped of the slug
 * prefix so callers get e.g. ["README.md", "app/server.js"] rather than
 * ["nodejs-dashboard/README.md", "nodejs-dashboard/app/server.js"].
 */
export async function fetchReferenceTree(slug: string): Promise<string[]> {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid reference slug: ${slug}`);
  }
  const all = await fetchRepoTree();
  const prefix = `${slug}/`;
  const out: string[] = [];
  for (const e of all) {
    if (e.type !== "blob") continue;
    if (!e.path.startsWith(prefix)) continue;
    out.push(e.path.slice(prefix.length));
  }
  out.sort();
  return out;
}

/**
 * Fetch a single file from a reference, e.g.
 * `fetchReferenceFile("nodejs-dashboard", "app/server.js")`.
 * Bounded to 1 MB to keep stray binaries / huge logs out of LLM context.
 */
export async function fetchReferenceFile(
  slug: string,
  relativePath: string,
): Promise<string> {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid reference slug: ${slug}`);
  }
  if (!SAFE_PATH_RE.test(relativePath) || relativePath.includes("..")) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }
  const cacheKey = `${slug}/${relativePath}`;
  const now = Date.now();
  const cached = fileCache.get(cacheKey);
  if (cached && now < cached.expiresAt) return cached.content;

  const url = `${RAW_BASE}/${slug}/${relativePath}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`${slug}/${relativePath}: HTTP ${res.status}`);
  }
  // Bounded read to defend against surprise large files.
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${slug}/${relativePath}: empty body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        throw new Error(
          `${slug}/${relativePath} exceeds ${MAX_FILE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    buf.set(c, pos);
    pos += c.byteLength;
  }
  const content = new TextDecoder("utf-8").decode(buf);
  fileCache.set(cacheKey, { content, expiresAt: now + FILE_CACHE_TTL_MS });
  return content;
}

/**
 * Compose a project bundle for the LLM: catalog entry + file tree +
 * pre-fetched README/getting_started/avocado.yaml + overlay summary.
 *
 * Files are fetched in parallel; any individual fetch failure becomes a null
 * field rather than a fatal error so the LLM gets partial data instead of an
 * outright failure.
 */
export async function fetchReferenceProject(
  slug: string,
): Promise<ReferenceProject> {
  const entry = getReferenceEntry(slug);
  if (!entry) {
    throw new Error(
      `Unknown reference "${slug}". Use list-references to see the catalog.`,
    );
  }
  const files = await fetchReferenceTree(slug);
  if (files.length === 0) {
    throw new Error(
      `Reference "${slug}" exists in catalog but no files found in the repo. Verify the slug matches the directory name in github.com/avocado-linux/references.`,
    );
  }

  const buildHooks = files.filter(
    (f) =>
      f === "app-clean.sh" || f === "app-compile.sh" || f === "app-install.sh",
  );

  const overlayPrefix = "app/overlay/";
  const overlayPaths = files
    .filter((f) => f.startsWith(overlayPrefix))
    .map((f) => f.slice(overlayPrefix.length));

  async function tryFetch(p: string): Promise<string | null> {
    try {
      return files.includes(p) ? await fetchReferenceFile(slug, p) : null;
    } catch {
      return null;
    }
  }
  const [readme, gettingStarted, avocadoYaml] = await Promise.all([
    tryFetch("README.md"),
    tryFetch("getting_started.md"),
    tryFetch("avocado.yaml"),
  ]);

  return {
    entry,
    sourceUrl: referenceUrl(slug),
    files,
    avocadoYaml,
    readme,
    gettingStarted,
    buildHooks,
    overlayPaths,
  };
}
