#!/usr/bin/env bash
#
# Install Field from this checkout: the `field` command, the audio daemon
# field-audiod, and the model-worker environments you have already set up.
#
#   ./install.sh [all|cli|audiod|workers|status]
#   field upgrade [all|cli|audiod|workers|status]   the same, from anywhere
#
# It installs the checkout it sits in, as that checkout is. It never pulls;
# `status` says how far the checkout is behind its upstream instead.
# Installing a release without a checkout is install.md chunk 3, and until
# then a copy of this script outside a checkout says so and stops.

set -euo pipefail

# The directory holding this script, or nothing when bash reads it from stdin.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fi
# A checkout is this script with the CLI's source beside it. pwd -P, so the
# path compares equal to the realpath of the checkout pnpm links.
REPO=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/src/cli.ts" ]; then
  REPO="$SCRIPT_DIR"
fi

NODE_MAJOR=24
# Where src/audiod/client.ts looks for the daemon, under the package root.
AUDIOD_RELATIVE="native/audiod/build/field-audiod_artefacts/Release/field-audiod"

die() {
  echo "install.sh: $1" >&2
  exit "${2:-1}"
}

row() { printf '%-14s %s\n' "$1" "$2"; }

# A row the reader must not scroll past: a marker always, because a captured
# log has no color, and bold yellow when stdout is a terminal.
warn_row() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    printf '\033[1;33m%-14s ⚠️  %s\033[0m\n' "$1" "$2"
  else
    printf '%-14s ⚠️  %s\n' "$1" "$2"
  fi
}

commits() {
  if [ "$1" -eq 1 ]; then printf '1 commit'; else printf '%s commits' "$1"; fi
}

# A path for a message, with the home directory as ~.
tilde() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The checkout pnpm's global `field` links, or nothing. pnpm keeps each
# global package in a directory of its own and reports where; that path is a
# symlink into the checkout `pnpm add -g` was given.
linked_checkout() {
  local path
  command -v pnpm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || return 0
  path="$(pnpm ls -g --json 2>/dev/null | node -e '
let text = "";
process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
  try {
    for (const entry of JSON.parse(text)) {
      const field = entry.dependencies && entry.dependencies.field;
      if (field && field.path) console.log(field.path);
    }
  } catch {}
});' 2>/dev/null)" || return 0
  path="${path%%$'\n'*}"
  [ -n "$path" ] && [ -d "$path" ] || return 0
  (CDPATH='' cd -- "$path" && pwd -P)
}

LINKED=""
refresh_linked() { LINKED="$(linked_checkout)"; }

# The command that runs a target again: `field upgrade` when the `field`
# pnpm links is this checkout, because that is the installer it runs, and
# this script's own path otherwise.
rerun() {
  if [ -n "$LINKED" ] && [ "$LINKED" = "$REPO" ]; then
    printf 'field upgrade %s' "$1"
  else
    printf '%s/install.sh %s' "$(tilde "$REPO")" "$1"
  fi
}

require_node() {
  local version
  version="$(node --version 2>/dev/null)" ||
    die "Field needs Node $NODE_MAJOR or newer, and node is not on PATH" 69
  version="${version#v}"
  [ "${version%%.*}" -ge "$NODE_MAJOR" ] 2>/dev/null ||
    die "Field needs Node $NODE_MAJOR or newer, and node is $version" 69
}

require_pnpm() {
  command -v pnpm >/dev/null 2>&1 ||
    die "Field builds with pnpm, which is not on PATH — run corepack enable pnpm, or see https://pnpm.io/installation" 69
}

# pnpm refuses to link into a global bin directory that is not on PATH, so
# the installer checks first and its message names the command to run again.
GLOBAL_BIN=""
require_global_bin() {
  GLOBAL_BIN="$(pnpm bin -g 2>/dev/null)" ||
    die "pnpm has no global bin directory — run pnpm setup, open a new shell, and run $(rerun "$TARGET") again" 69
  if [ "$LINKED" != "$REPO" ]; then
    case ":$PATH:" in
      *":$GLOBAL_BIN:"*) ;;
      *) die "pnpm's global bin directory $GLOBAL_BIN is not on PATH — run pnpm setup, open a new shell, and run $(rerun "$TARGET") again" 69 ;;
    esac
  fi
}

require_cmake() {
  command -v cmake >/dev/null 2>&1 ||
    die "building field-audiod needs CMake 3.24 or newer — brew install cmake on macOS" 69
}

install_cli() {
  # --frozen-lockfile, because an installer has no business rewriting the
  # checkout's lockfile; a checkout whose package.json moved ahead of it
  # gets pnpm's own error saying so.
  pnpm --dir "$REPO" install --frozen-lockfile
  # `pnpm install` builds through `prepare` only when it installed
  # something, so the build runs here too, every time: a checkout edited
  # without a commit is as stale as one that moved.
  pnpm --dir "$REPO" run build
  link_cli
}

# pnpm links the checkout rather than copying it, so a later build takes
# effect with no relinking. A link that already points here is left alone,
# and one that points at another checkout moves, with a row saying so.
link_cli() {
  local found
  if [ "$LINKED" != "$REPO" ]; then
    pnpm add -g "$REPO"
    [ -z "$LINKED" ] || row moved "field $(tilde "$LINKED") -> $(tilde "$REPO")"
    refresh_linked
  fi
  row linked "$(tilde "$GLOBAL_BIN/field") -> $(tilde "$REPO")"
  hash -r
  found="$(command -v field 2>/dev/null)" || found=""
  if [ -n "$found" ] && [ "$found" != "$GLOBAL_BIN/field" ]; then
    warn_row cli-shadowed "field on PATH is $(tilde "$found"), ahead of pnpm's $(tilde "$GLOBAL_BIN/field")"
  fi
}

install_audiod() {
  [ -x "$REPO/$AUDIOD_RELATIVE" ] ||
    row building "field-audiod for the first time: CMake fetches JUCE and compiles it, which takes several minutes"
  if ! pnpm --dir "$REPO" run build:native; then
    [ "$(uname -s)" != Linux ] ||
      echo "install.sh: on Linux, JUCE needs the ALSA, X11, and freetype development headers; .github/workflows/ci.yml installs the packages it needs on Ubuntu" >&2
    exit 1
  fi
  # CMake relinks field-audiod only when its own inputs change, and this
  # project builds other targets too. Dating the binary to this build lets
  # audiod-stale clear once the build it asks for has run.
  touch -c "$REPO/$AUDIOD_RELATIVE"
  row built "$(tilde "$REPO/$AUDIOD_RELATIVE")"
}

# Re-syncs the worker environments already set up and sets up no new one,
# because setting one up is explicit (ace-generation.md §3.4): the first
# generate after it downloads gigabytes of weights. The CLI decides which
# are set up, since it owns the list of workers.
install_workers() {
  [ -f "$REPO/dist/cli.js" ] ||
    die "the field CLI sets up worker environments, and it is not built — run $(rerun cli) first" 69
  node "$REPO/dist/cli.js" setup --existing
}

report_checkout_row() {
  local branch head
  head="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)" || {
    row checkout "$(tilde "$REPO") (not a git checkout)"
    return 0
  }
  if branch="$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null)"; then
    row checkout "$(tilde "$REPO") ($branch at $head)"
  else
    row checkout "$(tilde "$REPO") (detached at $head)"
  fi
}

# A checkout nobody pulled installs an old field, and nothing else says so.
# Fetch the checkout's upstream and say how far behind it is. FIELD_OFFLINE=1
# skips the fetch and compares against the last one. The fetch gives up
# after fifteen seconds of a stalled HTTP transfer, so a bad network delays
# the row rather than hanging the installer on it.
report_checkout() {
  local branch upstream remote behind ahead note=""
  git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || return 0
  if ! branch="$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null)"; then
    row repo-untracked "detached HEAD has no upstream to compare against"
    return 0
  fi
  if ! upstream="$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
    row repo-untracked "$branch has no upstream to compare against"
    return 0
  fi
  remote="${upstream%%/*}"
  if [ -n "${FIELD_OFFLINE:-}" ]; then
    note=" (offline; compared against the last fetch of $remote)"
  elif ! GIT_TERMINAL_PROMPT=0 git -C "$REPO" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 \
      fetch --quiet "$remote" 2>/dev/null; then
    note=" (could not fetch $remote; compared against its last fetch)"
  fi
  if ! behind="$(git -C "$REPO" rev-list --count "HEAD..$upstream" 2>/dev/null)"; then
    row repo-untracked "$branch tracks $upstream, which no longer exists$note"
    return 0
  fi
  ahead="$(git -C "$REPO" rev-list --count "$upstream..HEAD" 2>/dev/null)" || ahead=0
  if [ "$behind" -gt 0 ]; then
    warn_row repo-behind "$branch is $(commits "$behind") behind $upstream — run git pull in $(tilde "$REPO"), then $(rerun all)$note"
  elif [ "$ahead" -gt 0 ]; then
    row repo-ahead "$branch is $(commits "$ahead") ahead of $upstream$note"
  else
    row repo-current "$branch matches $upstream$note"
  fi
}

report_tools() {
  local version
  if version="$(node --version 2>/dev/null)"; then
    version="${version#v}"
    if [ "${version%%.*}" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      row node "$version"
    else
      warn_row node-old "$version — Field needs Node $NODE_MAJOR or newer"
    fi
  else
    warn_row node-missing "Field needs Node $NODE_MAJOR or newer"
  fi
  if version="$(pnpm --version 2>/dev/null)"; then
    row pnpm "$version"
  else
    warn_row pnpm-missing "run corepack enable pnpm, or see https://pnpm.io/installation"
  fi
  if version="$(cmake --version 2>/dev/null | sed -n '1s/.* //p')"; then
    row cmake "$version"
  else
    row cmake-missing "needed to build field-audiod — brew install cmake on macOS"
  fi
}

report_cli() {
  local bin found
  bin="$(pnpm bin -g 2>/dev/null)" || bin=""
  found="$(command -v field 2>/dev/null)" || found=""
  if [ -z "$LINKED" ]; then
    warn_row cli-missing "pnpm links no field — run $(rerun cli)"
  elif [ "$LINKED" != "$REPO" ]; then
    warn_row cli-elsewhere "field links $(tilde "$LINKED"), not this checkout — run $(rerun cli) to link this one"
  else
    row cli "$(tilde "$bin/field") -> $(tilde "$REPO")"
  fi
  if [ -n "$found" ] && [ "$found" != "$bin/field" ]; then
    warn_row cli-shadowed "field on PATH is $(tilde "$found"), ahead of pnpm's $(tilde "$bin/field")"
  elif [ -z "$found" ] && [ -n "$LINKED" ]; then
    warn_row not-on-path "pnpm's global bin directory $(tilde "$bin") is not on PATH — run pnpm setup"
  fi
  report_build
}

# Whether dist/ is the checkout as it stands. `pnpm build` stamps the commit
# it built and the number of uncommitted changes it saw
# (scripts/stamp-build.mjs), and `field --version` makes the same comparison.
report_build() {
  local info built built_dirty head dirty
  info="$REPO/dist/build-info.json"
  if [ ! -f "$info" ]; then
    warn_row cli-unbuilt "dist/ holds no build — run $(rerun cli)"
    return 0
  fi
  read -r built built_dirty < <(INFO="$info" node -e '
const info = JSON.parse(require("fs").readFileSync(process.env.INFO, "utf8"));
console.log(`${info.commit ?? "-"} ${info.dirtyFiles ?? 0}`);' 2>/dev/null) || true
  head="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" || head=""
  if [ -z "${built:-}" ] || [ "$built" = "-" ] || [ -z "$head" ]; then
    row cli-built "dist/ has a build, and no commit to compare it against"
    return 0
  fi
  if [ "$built" != "$head" ]; then
    warn_row cli-stale "dist/ was built from ${built:0:7}, and the checkout is at ${head:0:7} — run $(rerun cli)"
    return 0
  fi
  dirty="$(git -C "$REPO" status --porcelain 2>/dev/null | grep -c . || true)"
  if [ "${dirty:-0}" -ne "${built_dirty:-0}" ]; then
    warn_row cli-stale "dist/ was built with $built_dirty uncommitted changes, and the checkout has $dirty — run $(rerun cli)"
    return 0
  fi
  row cli-current "built from ${head:0:7}"
}

# The first tracked daemon source newer than the binary. install_audiod
# touches the binary after each build, so this names a source changed
# since the installer last built the daemon.
audiod_changed() {
  local file
  while IFS= read -r -d '' file; do
    if [ "$REPO/$file" -nt "$1" ]; then
      printf '%s\n' "$file"
      return 0
    fi
  done < <(git -C "$REPO" ls-files -z -- native/audiod 2>/dev/null)
  return 1
}

report_audiod() {
  local binary="$REPO/$AUDIOD_RELATIVE" changed
  [ -z "${FIELD_AUDIOD:-}" ] ||
    row audiod-override "FIELD_AUDIOD is set, so field runs $(tilde "$FIELD_AUDIOD") instead of this build"
  if [ ! -x "$binary" ]; then
    warn_row audiod-missing "field-audiod is not built — run $(rerun audiod)"
  elif changed="$(audiod_changed "$binary")"; then
    warn_row audiod-stale "$changed changed since field-audiod was built — run $(rerun audiod)"
  else
    row audiod-current "$(tilde "$binary")"
  fi
}

# `field setup --check` prints one row per worker in this format. A worker
# that is set up and out of date, or set up with uv gone, is a warning.
report_workers() {
  local label rest
  if [ ! -f "$REPO/dist/cli.js" ] || ! command -v node >/dev/null 2>&1; then
    row workers "unknown until the CLI is built"
    return 0
  fi
  while read -r label rest; do
    case "$label" in
      worker-stale|worker-no-uv) warn_row "$label" "$rest" ;;
      *) row "$label" "$rest" ;;
    esac
  done < <(node "$REPO/dist/cli.js" setup --check 2>&1 || true)
}

show_status() {
  report_checkout_row
  report_checkout
  report_tools
  report_cli
  report_audiod
  report_workers
}

if [ -z "$REPO" ]; then
  die "run this from a Field checkout: git clone https://github.com/okamnesiac/field, then ./install.sh in it" 69
fi
[ $# -le 1 ] || die "usage: install.sh [all|cli|audiod|workers|status]" 64
TARGET="${1:-all}"
refresh_linked

# Each target checks every prerequisite it needs before its first command,
# so a missing one stops it with nothing changed.
case "$TARGET" in
  all)
    require_node
    require_pnpm
    require_global_bin
    require_cmake
    install_cli
    install_audiod
    install_workers
    report_checkout
    ;;
  cli) require_node; require_pnpm; require_global_bin; install_cli; report_checkout ;;
  audiod) require_pnpm; require_cmake; install_audiod; report_checkout ;;
  workers) require_node; install_workers; report_checkout ;;
  status) show_status ;;
  *) die "usage: install.sh [all|cli|audiod|workers|status]" 64 ;;
esac
