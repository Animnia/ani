#!/usr/bin/env bash
# ani installer — one line:
#   curl -fsSL https://raw.githubusercontent.com/Animnia/ani/main/install.sh | bash
#
# What it does:
#   1. ensures Node.js >= 24 (downloads an official binary into ~/.ani/node if missing)
#   2. clones (or tarball-downloads) ani into ~/.ani
#   3. installs an `ani` command into ~/.ani/bin (+ PATH hint)
#   4. seeds ~/.ani/ani.json from the example config
# Re-running updates ani (git pull).
#
# Env overrides:
#   ANI_DIR          install dir        (default: ~/.ani)
#   ANI_NODE_MIRROR  node dist mirror   (default: https://nodejs.org/dist)
#                    e.g. https://registry.npmmirror.com/-/binary/node for CN users
set -euo pipefail

REPO="https://github.com/Animnia/ani"
RAW="https://raw.githubusercontent.com/Animnia/ani/main"
ANI_DIR="${ANI_DIR:-$HOME/.ani}"
MIRROR="${ANI_NODE_MIRROR:-https://nodejs.org/dist}"
MIN_MAJOR=24

say()  { printf '\033[36m[ani]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ani]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[ani] %s\033[0m\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

node_ok() {
  need node || return 1
  local v
  v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$v" -ge "$MIN_MAJOR" ] 2>/dev/null
}

install_node() {
  local os arch version tarball url
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             die "unsupported arch: $(uname -m)" ;;
  esac
  say "node >= $MIN_MAJOR not found — downloading official binary ($os-$arch)…"
  # resolve the exact tarball from SHASUMS256.txt inside latest-vN.x (index.json
  # lists newer majors first — do NOT use it for version resolution)
  tarball="$(curl -fsSL --max-time 30 "$MIRROR/latest-v${MIN_MAJOR}.x/SHASUMS256.txt" | awk '{print $2}' | grep -E "node-v[0-9.]+-${os}-${arch}\.tar\.xz$" | head -1)"
  [ -n "$tarball" ] || die "could not resolve Node $MIN_MAJOR tarball from $MIRROR"
  url="$MIRROR/latest-v${MIN_MAJOR}.x/${tarball}"
  say "fetching $url"
  mkdir -p "$ANI_DIR"
  curl -fsSL --max-time 300 "$url" -o "$ANI_DIR/node.tar.xz" \
    || die "node download failed (set ANI_NODE_MIRROR, e.g. https://registry.npmmirror.com/-/binary/node)"
  tar -xJf "$ANI_DIR/node.tar.xz" -C "$ANI_DIR" || die "tar extract failed (need xz support)"
  rm -f "$ANI_DIR/node.tar.xz"
  rm -rf "$ANI_DIR/node"
  mv "$ANI_DIR/${tarball%.tar.xz}" "$ANI_DIR/node"
  say "node installed to $ANI_DIR/node"
}

say "=== ani installer ==="
mkdir -p "$ANI_DIR"

# 1. node
if node_ok; then
  say "found node $(node --version)"
else
  install_node
fi
export PATH="$ANI_DIR/node/bin:$PATH"
node_ok || die "node setup failed"
say "using $(node --version) at $(command -v node)"

# 2. ani source
if [ -d "$ANI_DIR/.git" ] && need git; then
  say "updating existing install…"
  git -C "$ANI_DIR" pull --ff-only || warn "git pull failed — keeping current version"
elif need git; then
  # init+fetch works even when $ANI_DIR already holds a node/ dir
  if [ -n "$(ls -A "$ANI_DIR" 2>/dev/null | grep -v '^node$' | grep -v '^bin$' || true)" ]; then
    die "$ANI_DIR is not empty and not an ani checkout — set ANI_DIR to elsewhere"
  fi
  say "fetching $REPO …"
  git -C "$ANI_DIR" init -b main -q
  git -C "$ANI_DIR" remote add origin "$REPO.git"
  git -C "$ANI_DIR" fetch --depth 1 origin main -q
  git -C "$ANI_DIR" checkout -qf -t origin/main
else
  say "git not found — downloading tarball…"
  tmp="$ANI_DIR/.dl"; rm -rf "$tmp"; mkdir -p "$tmp"
  curl -fsSL --max-time 300 "https://codeload.github.com/Animnia/ani/tar.gz/refs/heads/main" -o "$tmp/ani.tar.gz" \
    || die "download failed"
  tar -xzf "$tmp/ani.tar.gz" -C "$tmp"
  cp -R "$tmp/ani-main/." "$ANI_DIR/"
  rm -rf "$tmp"
fi

# 3. ani command
mkdir -p "$ANI_DIR/bin"
cat > "$ANI_DIR/bin/ani" <<EOF
#!/usr/bin/env bash
if [ -x "$ANI_DIR/node/bin/node" ]; then
  exec "$ANI_DIR/node/bin/node" "$ANI_DIR/ani.ts" "\$@"
else
  exec node "$ANI_DIR/ani.ts" "\$@"
fi
EOF
chmod +x "$ANI_DIR/bin/ani"

# PATH hint (append once to common rc files)
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$rc" ] && ! grep -qF "$ANI_DIR/bin" "$rc" 2>/dev/null; then
    printf '\nexport PATH="%s/bin:$PATH"\n' "$ANI_DIR" >> "$rc"
    say "added $ANI_DIR/bin to PATH in $rc"
  fi
done

# 4. config
if [ ! -f "$ANI_DIR/ani.json" ]; then
  cp "$ANI_DIR/ani.example.json" "$ANI_DIR/ani.json"
  say "created $ANI_DIR/ani.json — EDIT IT: add your DeepSeek apiKey and channel tokens"
fi

say ""
say "✅ ani installed to $ANI_DIR"
say "next steps:"
say "  1. edit config:   \$EDITOR $ANI_DIR/ani.json"
say "  2. open a new terminal (PATH) and run:  ani"
say "     or right now:  $ANI_DIR/bin/ani"
