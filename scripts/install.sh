#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Smart Tab Hygiene — Install / Register Native Messaging Host
#
# This script:
#   1. Builds the SmartTabHygieneCompanion Swift executable
#   2. Registers it as a Native Messaging host for Chrome & Edge
#   3. Creates the JSON manifest in the correct browser directories
#
# Usage:
#   chmod +x scripts/install.sh
#   ./scripts/install.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPANION_DIR="$PROJECT_DIR/companion/MimoCompanion"
HOST_NAME="com.smarttabhygiene.companion"
BINARY_PATH="$HOME/.local/bin/SmartTabHygieneCompanion"
EXTENSION_ID="${1:-${MIMO_EXTENSION_ID:-REPLACE_WITH_EXTENSION_ID}}"
PREBUILT_BINARY="${MIMO_COMPANION_BINARY:-}"

# ── Colours ────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[Smart Tab Hygiene]${NC} $*"; }
ok()    { echo -e "${GREEN}[Smart Tab Hygiene]${NC} $*"; }
warn()  { echo -e "${YELLOW}[Smart Tab Hygiene]${NC} $*"; }
err()   { echo -e "${RED}[Smart Tab Hygiene]${NC} $*" >&2; }

# ── Step 1: Build the companion ────────────────────────────────────

if [ -n "$PREBUILT_BINARY" ]; then
    info "Using prebuilt SmartTabHygieneCompanion: $PREBUILT_BINARY"
    if [ ! -f "$PREBUILT_BINARY" ]; then
        err "Prebuilt binary not found: $PREBUILT_BINARY"
        exit 1
    fi
    BUILD_BINARY="$PREBUILT_BINARY"
else
    info "Building SmartTabHygieneCompanion..."
    cd "$COMPANION_DIR"

    if ! command -v swift &>/dev/null; then
        err "Swift not found. Install Xcode/Command Line Tools, or set MIMO_COMPANION_BINARY=/path/to/SmartTabHygieneCompanion."
        exit 1
    fi

    swift build -c release 2>&1 | tail -5
    BUILD_BINARY="$COMPANION_DIR/.build/release/SmartTabHygieneCompanion"
fi

if [ ! -f "$BUILD_BINARY" ]; then
    err "Build failed — binary not found at $BUILD_BINARY"
    exit 1
fi

ok "Build succeeded"

# ── Step 2: Install binary ─────────────────────────────────────────

mkdir -p "$HOME/.local/bin"
cp "$BUILD_BINARY" "$BINARY_PATH"
chmod +x "$BINARY_PATH"
ok "Installed binary to $BINARY_PATH"

# ── Step 3: Register Native Messaging Host ─────────────────────────

# Generate the JSON manifest
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Smart Tab Hygiene Companion — Idle prediction via Core ML",
  "path": "$BINARY_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
)

register_host() {
    local browser="$1"
    local manifest_dir="$2"

    if [ ! -d "$(dirname "$manifest_dir")" ]; then
        warn "$browser not found — skipping"
        return
    fi

    mkdir -p "$manifest_dir"
    echo "$MANIFEST_JSON" > "$manifest_dir/$HOST_NAME.json"
    ok "Registered for $browser at $manifest_dir/$HOST_NAME.json"
}

# Chrome (stable, beta, dev, canary)
register_host "Chrome" \
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

register_host "Chrome Beta" \
    "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"

register_host "Chrome Dev" \
    "$HOME/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts"

register_host "Chrome Canary" \
    "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"

# Edge (stable, beta, dev, canary)
register_host "Edge" \
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

register_host "Edge Beta" \
    "$HOME/Library/Application Support/Microsoft Edge Beta/NativeMessagingHosts"

register_host "Edge Dev" \
    "$HOME/Library/Application Support/Microsoft Edge Dev/NativeMessagingHosts"

register_host "Edge Canary" \
    "$HOME/Library/Application Support/Microsoft Edge Canary/NativeMessagingHosts"

# Chromium
register_host "Chromium" \
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"

# ── Step 4: Print extension ID instructions ────────────────────────

echo ""
info "═══════════════════════════════════════════════════════════"
info "Next steps:"
info ""
info "1. Load the extension in Chrome/Edge:"
info "   • Open chrome://extensions (or edge://extensions)"
info "   • Enable 'Developer mode'"
info "   • Click 'Load unpacked' → select:"
info "     $PROJECT_DIR/extension"
info ""
info "2. Copy the extension ID from the extensions page"
info ""
if [ "$EXTENSION_ID" = "REPLACE_WITH_EXTENSION_ID" ]; then
info "3. Update the manifest files:"
BROWSER_MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
info "   Edit: $BROWSER_MANIFEST_DIR/$HOST_NAME.json"
info "   Replace 'REPLACE_WITH_EXTENSION_ID' with your actual ID"
info "   Or rerun: ./scripts/install.sh <extension-id>"
else
info "3. Native Messaging allowed origin set to:"
info "   chrome-extension://$EXTENSION_ID/"
fi
info ""
info "4. Restart the browser"
info ""
info "5. The companion will start automatically when the extension"
info "   connects. Check logs at:"
info "   ~/Library/Application Support/Smart Tab Hygiene/companion.log"
info "═══════════════════════════════════════════════════════════"

ok "Installation complete!"
