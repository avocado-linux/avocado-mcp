#!/usr/bin/env bash
set -euo pipefail

# Re-vendor the Yocto/BitBake reference corpus under yocto-refs/.
#
# Two modes:
#   --local   (default) copy each file out of a locally cloned repo under
#             ~/repos/personal/yocto/ using `git show <ref>:<path>` so the
#             checkout is never disturbed.
#   --fetch   download each file from raw.githubusercontent.com.
#
# Flags:
#   --release <name>  Yocto release branch (default: scarthgap). oe-core and
#                     yocto-docs use the release name directly as the branch;
#                     bitbake uses a version-numbered branch instead, so the
#                     release name is mapped to a bitbake branch (see
#                     bitbake_branch_for_release below).
#
# After updating the files, yocto-refs/VERSION is regenerated.

usage() {
  cat >&2 <<'EOF'
usage: refresh-yocto-corpus.sh [--local|--fetch] [--release <name>]

  --local            copy from ~/repos/personal/yocto/ (default)
  --fetch            download from raw.githubusercontent.com
  --release <name>   Yocto release branch (default: scarthgap)
  -h, --help         show this help
EOF
}

mode="local"
release="scarthgap"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) mode="local"; shift ;;
    --fetch) mode="fetch"; shift ;;
    --release)
      [[ $# -ge 2 ]] || { echo "error: --release requires an argument" >&2; exit 2; }
      release="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# Repo root is the parent of this script's scripts/ directory.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
refs_dir="${repo_root}/yocto-refs"
version_file="${refs_dir}/VERSION"

# Local clone locations for --local mode.
local_root="${HOME}/repos/personal/yocto"

# Map a Yocto release name to the matching bitbake version-numbered branch.
# bitbake does not use release codenames as branch names.
bitbake_branch_for_release() {
  case "$1" in
    scarthgap) echo "2.8" ;;
    # For other releases, pass the value through and let the caller fail
    # loudly if the branch does not exist. Extend this map as releases land.
    *) echo "$1" ;;
  esac
}

bitbake_branch="$(bitbake_branch_for_release "${release}")"

# Each corpus entry: vendored path | repo key | branch | source path in repo.
# repo key selects both the local clone dir and the github org/repo slug.
#   bitbake           -> ~/repos/personal/yocto/bitbake            | openembedded/bitbake
#   openembedded-core -> ~/repos/personal/yocto/openembedded-core  | openembedded/openembedded-core
#   yocto-docs        -> ~/repos/personal/yocto/yocto-docs         | yoctoproject/yocto-docs
entries=(
  "bitbake/doc/bitbake-user-manual/bitbake-user-manual-metadata.rst|bitbake|${bitbake_branch}|doc/bitbake-user-manual/bitbake-user-manual-metadata.rst"
  "openembedded-core/meta/lib/oe/qa.py|openembedded-core|${release}|meta/lib/oe/qa.py"
  "openembedded-core/meta/classes-global/insane.bbclass|openembedded-core|${release}|meta/classes-global/insane.bbclass"
  "yocto-docs/documentation/ref-manual/variables.rst|yocto-docs|${release}|documentation/ref-manual/variables.rst"
  "yocto-docs/documentation/ref-manual/qa-checks.rst|yocto-docs|${release}|documentation/ref-manual/qa-checks.rst"
)

repo_url_for_key() {
  case "$1" in
    bitbake) echo "https://git.openembedded.org/bitbake" ;;
    openembedded-core) echo "https://git.openembedded.org/openembedded-core" ;;
    yocto-docs) echo "https://git.yoctoproject.org/yocto-docs" ;;
    *) echo "error: unknown repo key: $1" >&2; return 1 ;;
  esac
}

github_slug_for_key() {
  case "$1" in
    bitbake) echo "openembedded/bitbake" ;;
    openembedded-core) echo "openembedded/openembedded-core" ;;
    yocto-docs) echo "yoctoproject/yocto-docs" ;;
    *) echo "error: unknown repo key: $1" >&2; return 1 ;;
  esac
}

# Build the raw fetch URL for a given repo, branch, and in-repo path.
# bitbake and openembedded-core are mirrored on GitHub (raw.githubusercontent.com).
# yocto-docs is at git.yoctoproject.org, not GitHub; use its cgit plain URL instead.
build_fetch_url() {
  local repo_key="$1" branch="$2" src_path="$3"
  case "${repo_key}" in
    bitbake|openembedded-core)
      local slug
      slug="$(github_slug_for_key "${repo_key}")"
      echo "https://raw.githubusercontent.com/${slug}/${branch}/${src_path}"
      ;;
    yocto-docs)
      echo "https://git.yoctoproject.org/yocto-docs/plain/${src_path}?h=${branch}"
      ;;
    *) echo "error: unknown repo key: ${repo_key}" >&2; return 1 ;;
  esac
}

local_repo_for_key() {
  echo "${local_root}/$1"
}

# Collected SHAs keyed by repo key, resolved during the update pass.
declare -A repo_sha

update_local() {
  local vendored="$1" repo_key="$2" branch="$3" src_path="$4"
  local clone dest
  clone="$(local_repo_for_key "${repo_key}")"
  dest="${refs_dir}/${vendored}"

  [[ -d "${clone}/.git" ]] || {
    echo "error: local clone not found: ${clone} (run with --fetch instead?)" >&2
    exit 1
  }

  echo "local: ${repo_key}@${branch}:${src_path} -> ${vendored}"
  mkdir -p "$(dirname "${dest}")"
  # Non-destructive extraction: read the blob out of the remote tracking ref so
  # a local checkout at a different branch does not interfere.
  git -C "${clone}" show "origin/${branch}:${src_path}" > "${dest}"

  repo_sha["${repo_key}"]="$(git -C "${clone}" rev-parse "origin/${branch}")"
}

update_fetch() {
  local vendored="$1" repo_key="$2" branch="$3" src_path="$4"
  local url dest
  url="$(build_fetch_url "${repo_key}" "${branch}" "${src_path}")"
  dest="${refs_dir}/${vendored}"

  echo "fetch: ${url} -> ${vendored}"
  mkdir -p "$(dirname "${dest}")"
  local tmp
  tmp="$(mktemp)"
  # --fail makes curl exit non-zero on an HTTP error (e.g. an unknown branch
  # returns 404), so a bad --release surfaces as a hard failure naming it.
  if ! curl --fail --silent --show-error --location "${url}" --output "${tmp}"; then
    rm -f "${tmp}"
    echo "error: failed to fetch ${url} (release/branch '${branch}' may not exist)" >&2
    exit 1
  fi
  mv "${tmp}" "${dest}"

  # In fetch mode the branch name is the best SHA we have without an extra API
  # round-trip; record it as a placeholder.
  repo_sha["${repo_key}"]="${branch}"
}

for entry in "${entries[@]}"; do
  IFS='|' read -r vendored repo_key branch src_path <<< "${entry}"
  if [[ "${mode}" == "local" ]]; then
    update_local "${vendored}" "${repo_key}" "${branch}" "${src_path}"
  else
    update_fetch "${vendored}" "${repo_key}" "${branch}" "${src_path}"
  fi
done

# Regenerate VERSION as a YAML list, one entry per vendored file.
echo "writing ${version_file}"
today="$(date +%Y-%m-%d)"
{
  for entry in "${entries[@]}"; do
    IFS='|' read -r vendored repo_key branch _src_path <<< "${entry}"
    repo_url="$(repo_url_for_key "${repo_key}")"
    printf -- '- file: %s\n' "${vendored}"
    printf -- '  repo: %s\n' "${repo_url}"
    printf -- '  branch: "%s"\n' "${branch}"
    printf -- '  sha: %s\n' "${repo_sha["${repo_key}"]}"
    printf -- '  date: %s\n' "${today}"
  done
} > "${version_file}"

echo "done: corpus refreshed for release '${release}' (mode: ${mode})"
