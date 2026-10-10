#!/usr/bin/env bash
# Errand installer for macOS and Linux. No admin rights, no Git, no coding.
#
#   curl -fsSL https://raw.githubusercontent.com/FurquanEats/errand/main/scripts/install.sh | bash
#
# Installs into ~/Errand (app, a private copy of Node.js if needed, and your data), adds an
# Errand launcher, and opens it. Run it again any time to update; your data is kept.
# Optional: set ERRAND_HOME to install elsewhere, ERRAND_PORT to use another port.
set -euo pipefail

REPO="FurquanEats/errand"
ROOT="${ERRAND_HOME:-$HOME/Errand}"
PORT="${ERRAND_PORT:-4747}"
APP_DIR="$ROOT/app"
DATA_DIR="$ROOT/data"
NODE_DIR="$ROOT/node"
MIN_MAJOR=22
MIN_MINOR=13

step() { printf '\n  \033[1m%s\033[0m\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }
fail() { printf '\n  \033[31m%s\033[0m\n' "$1" >&2; exit 1; }

printf '\n  \033[1mErrand setup\033[0m\n'
info "Installing to $ROOT"
info "Errand runs on this computer and sends nothing to us. What it sends where: https://github.com/FurquanEats/errand/blob/main/PRIVACY.md"
mkdir -p "$ROOT" "$DATA_DIR"
# Errand runs in the background; quit it so its files can be updated.
if curl -fs --max-time 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
  info "Closing Errand to update it"
  curl -fs --max-time 5 -X POST -H 'X-Errand: 1' "http://127.0.0.1:$PORT/api/quit" >/dev/null 2>&1 || true
  sleep 3
  if curl -fs --max-time 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
    fail "Errand is still running. Stop it first, then run setup again to update."
  fi
fi

node_ok() { # $1 = path to node
  local v; v="$("$1" -v 2>/dev/null | sed 's/^v//')" || return 1
  local major="${v%%.*}" rest="${v#*.}"; local minor="${rest%%.*}"
  [ "$major" -gt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; }
}

# ── Node.js ──────────────────────────────────────────────────────────────
step "Checking Node.js"
NODE=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"; info "Using installed Node.js $(node -v)"
elif [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  NODE="$NODE_DIR/bin/node"; info "Using Errand's Node.js $("$NODE" -v)"
else
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "Unsupported system: $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail "Unsupported CPU: $(uname -m)" ;; esac
  # Newest LTS release (index.json lists newest first).
  ver="$(curl -fsSL https://nodejs.org/dist/index.json | tr '{' '\n' | awk '/"lts":"/ && !found { match($0, /"version":"v[0-9.]+"/); print substr($0, RSTART + 11, RLENGTH - 12); found = 1 }')"
  [ -n "$ver" ] || fail "Could not find a Node.js release to download."
  name="node-$ver-$os-$arch"
  info "Downloading Node.js $ver (private copy, about 30 MB)"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$ver/$name.tar.gz" -o "$tmp/$name.tar.gz"
  # Verify the download against Node's published checksums.
  expected="$(curl -fsSL "https://nodejs.org/dist/$ver/SHASUMS256.txt" | grep " $name.tar.gz\$" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1)"
  else actual="$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1)"; fi
  [ -n "$expected" ] && [ "$actual" = "$expected" ] || fail "Node.js download failed its checksum. Please try again."
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  rm -rf "$NODE_DIR"; mv "$tmp/$name" "$NODE_DIR"; rm -rf "$tmp"
  NODE="$NODE_DIR/bin/node"
fi
NODE_BIN="$(dirname "$NODE")"
export PATH="$NODE_BIN:$PATH"

# ── Errand ───────────────────────────────────────────────────────────────
step "Downloading Errand"
# The latest release; falls back to the main branch before the first release exists.
# ERRAND_REF installs a specific branch, tag or commit instead (used by CI).
ref="${ERRAND_REF:-refs/heads/main}"
if [ -z "${ERRAND_REF:-}" ]; then
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | awk -F'"' '/"tag_name"/ && !found { print $4; found = 1 }' || true)"
  if [ -n "$tag" ]; then ref="refs/tags/$tag"; info "Version $tag"; fi
fi
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/$REPO/archive/$ref.tar.gz" | tar -xz -C "$tmp"
rm -rf "$APP_DIR"; mv "$tmp"/*/ "$APP_DIR"; rm -rf "$tmp"

step "Setting it up (a minute or two)"
( cd "$APP_DIR" && npm install --no-audit --no-fund --loglevel=error && npm run build --silent ) || fail "Setup failed. Please try again."

# ── Launcher ─────────────────────────────────────────────────────────────
step "Adding an Errand launcher"
LAUNCHER="$ROOT/errand"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
export ERRAND_HOME="$ROOT"
export ERRAND_DATA_DIR="$DATA_DIR"
export ERRAND_PORT="$PORT"
export PATH="$NODE_BIN:\$PATH"
# --background (used when starting at login) starts Errand without opening its window.
[ "\${1:-}" = "--background" ] || export ERRAND_OPEN=1
cd "$APP_DIR"
# Runs in the background, so closing a window never stops it; opening it again just shows the
# window. Quit from Errand's menu. Output goes to errand.log.
nohup "$NODE" --disable-warning=ExperimentalWarning --import tsx server/index.ts >"$ROOT/errand.log" 2>&1 &
EOF
chmod +x "$LAUNCHER"

if [ "$(uname -s)" = "Darwin" ]; then
  # A real app with Errand's icon, in Applications and on the Desktop.
  APP="$HOME/Applications/Errand.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  printf '#!/bin/bash\nexec "%s"\n' "$LAUNCHER" > "$APP/Contents/MacOS/Errand"
  chmod +x "$APP/Contents/MacOS/Errand"
  ICONSET="$(mktemp -d)/Errand.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$APP_DIR/web/public/icon-512.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    if [ $s -le 256 ]; then sips -z $((s * 2)) $((s * 2)) "$APP_DIR/web/public/icon-512.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true; fi
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Errand.icns" >/dev/null 2>&1 || true
  cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Errand</string>
<key>CFBundleIdentifier</key><string>in.zovle.errand</string>
<key>CFBundleExecutable</key><string>Errand</string>
<key>CFBundleIconFile</key><string>Errand</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
  rm -f "$HOME/Desktop/Errand.command"
  if [ -d "$HOME/Desktop" ]; then ln -sfn "$APP" "$HOME/Desktop/Errand.app"; fi
  info "Open it next time from Errand in your Applications folder or on your Desktop."
else
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/errand.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Errand
Comment=Your personal AI agent
Exec=$LAUNCHER
Icon=$APP_DIR/web/public/icon-512.png
Terminal=false
Categories=Utility;
EOF
  info "Open it next time from your app menu, or run: $LAUNCHER"
fi

printf '\n  \033[32mDone. Errand is opening.\033[0m\n'
info "It keeps running in the background. To stop it, choose Quit Errand in its menu."
echo
exec "$LAUNCHER"
