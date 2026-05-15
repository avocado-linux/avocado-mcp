export const URI = "avocado://skills/extension-build-debugging";
export const NAME = "extension-build-debugging";
export const DESCRIPTION =
  "How to triage failures inside user-authored extension build hooks (`app-clean.sh`, `app-compile.sh`, `app-install.sh`). Read this whenever `explain-build-error` returns a `Hook script:` pattern — the failure is in the user's code, not Avocado, and the diagnostic path is different from SDK/feed bugs.";

export const CONTENT = `# Debugging user-authored extension build hooks

When \`avocado install\` or \`avocado build\` fails inside one of an extension's hook scripts, the failure is in user code, not in Avocado. This skill is the triage guide.

## The hook lifecycle

For each extension declared in \`avocado.yaml\`, the SDK looks for three optional hook scripts at the extension root:

- **\`app-clean.sh\`** — wipes stale build state. Runs first. Must be idempotent.
- **\`app-compile.sh\`** — compiles application code against the SDK toolchain.
- **\`app-install.sh\`** — stages compiled artifacts + overlay files into the extension's root tree.

If any hook exits non-zero, the build halts and the log shows the failing path + line number. Hooks are optional — interpreted-language extensions (Python, Node, shell) often have no compile step and rely on the \`app/overlay/\` directory + the \`packages:\` map instead.

## Environment available inside hooks

- Hooks run **inside the SDK container** (\`docker.io/avocadolinux/sdk:<release>-<channel>\`), NOT on the host. \`uname\` reports the container, not the host.
- **\`$DESTDIR\`** — the staging root the install hook must write under. Treat it as the device's \`/\`. \`cp myapp $DESTDIR/usr/bin/myapp\` → ends up at \`/usr/bin/myapp\` on the device.
- **\`$CC\`, \`$CXX\`, \`$AR\`, \`$LD\`, \`$PKG_CONFIG_PATH\`** — point at the SDK's cross-toolchain. Use these in Makefiles / configure scripts, NEVER call \`gcc\` directly.
- **\`/bin/sh\`** is \`dash\` / \`ash\` on most SDK images, not bash. Avoid bashisms unless the script's shebang is explicitly \`#!/bin/bash\` AND bash is listed under \`sdk.packages\`.
- The hook's working directory is the extension's app directory (where the hook lives).

## Common failure modes

### 1. \`command not found\` inside a hook

**What it looks like:**
\`\`\`
app-compile.sh: line 5: cmake: command not found
\`\`\`

**Cause:** the tool isn't installed in the SDK container.

**Fix:** add it to \`sdk.packages\` in \`avocado.yaml\` (NOT your extension's \`packages:\` — SDK packages live in the build container, extension packages get baked into the device image). Always verify the package name with \`search-packages\` first.

\`\`\`yaml
sdk:
  packages:
    cmake: "*"
    pkgconfig: "*"
\`\`\`

### 2. \`Permission denied\` writing to a path

**What it looks like:**
\`\`\`
app-install.sh: line 7: cannot create regular file '/usr/bin/myapp': Permission denied
\`\`\`

**Cause:** the hook tried to write outside \`$DESTDIR\`. The build container runs unprivileged; \`/usr/bin\` etc. are read-only.

**Fix:** prefix every install path with \`$DESTDIR\`. The path you want on the final device (\`/usr/bin/foo\`) becomes \`$DESTDIR/usr/bin/foo\` during the build.

\`\`\`bash
install -d $DESTDIR/usr/bin
install -m 0755 build/myapp $DESTDIR/usr/bin/myapp
\`\`\`

### 3. \`No such file or directory\` for a source / artifact

**Cause:** relative paths in the hook don't resolve where the author thought. The hook runs from the extension's app directory, not from the project root and not from \`build/\`.

**Fix:** anchor paths to a known location. Either use absolute paths starting from the hook's own dir (\`SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\`) or pass explicit subdirs.

### 4. Cross-compile mismatch (binary exists but won't run on device)

**Symptom:** \`avocado build\` succeeds, but on the device the binary fails with \`exec format error\` or an interpreter mismatch.

**Cause:** the hook compiled with the host's compiler, not the SDK's cross-compiler.

**Fix:** use \`$CC\`, \`$CXX\` everywhere. \`make CC="$CC" CXX="$CXX"\` for Make; \`--with-cc="$CC"\` for autotools; \`-DCMAKE_C_COMPILER="$CC"\` for CMake.

### 5. Make / CMake compilation errors

\`error: foo.c:42:1: undeclared identifier\` etc. These are normal compile errors in user source. Open the named file at the named line and fix the code.

### 6. \`syntax error\` from \`dash\` / \`ash\`

**What it looks like:**
\`\`\`
app-compile.sh: line 3: syntax error: unexpected "("
\`\`\`

**Cause:** the script uses bash-specific syntax (\`[[ ]]\`, \`function name()\`, process substitution \`<()\`) but \`/bin/sh\` is dash/ash on this SDK.

**Fix:** either rewrite in POSIX shell, or set \`#!/bin/bash\` AND declare \`bash\` under \`sdk.packages\`.

## Triage order when a hook fails

1. **Identify the hook** — the error log path shows \`app-clean.sh\`, \`app-compile.sh\`, or \`app-install.sh\`. That tells you whether the failure was in cleanup, compile, or staging.
2. **Read the hook file** with the \`Read\` tool (or \`cat\` via Bash) at the line number from the error.
3. **Compare against a working reference's same hook.** Call \`get-reference-file\` with a closely related reference and the same hook path (e.g. \`python-flask/app-install.sh\` for a Python install hook; \`cpp-tui-dashboard/app-compile.sh\` for a C++ compile hook). Diff the patterns.
4. **Map the symptom to a failure mode above** and apply the fix.
5. **Do not** go down the SDK / cross-channel / host-arch path for hook failures — those investigations only apply to feed/package-level errors.

## When a hook isn't actually needed

For pure interpreted-language extensions (a Python script, a Node app), \`app-compile.sh\` and often \`app-install.sh\` can be empty or absent — drop the source files into \`app/overlay/usr/lib/myapp/...\` and let the overlay mechanism stage them. Look at \`python-mqtt\` or \`shell-heartbeat\` for minimal-hook patterns.
`;
