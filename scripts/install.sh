#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Neural-Janitor — Install / Register Native Messaging Host
#
# This script:
#   1. Builds the NeuralJanitorCompanion Swift executable
#   2. Registers it as a Native Messaging host for Chrome & Edge
#   3. Creates the JSON manifest in the correct browser directories
#
# Usage:
#   chmod +x scripts/install.sh
#   ./scripts/install.sh <chrome-extension-id> [edge-extension-id]
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPANION_DIR="$PROJECT_DIR/companion/NeuralJanitorCompanion"
HOST_NAME="com.neuraljanitor.companion"
BINARY_PATH="$HOME/.local/bin/NeuralJanitorCompanion"
PREBUILT_BINARY="${NEURAL_JANITOR_COMPANION_BINARY:-${SMART_TAB_HYGIENE_COMPANION_BINARY:-${MIMO_COMPANION_BINARY:-}}}"

EXTENSION_IDS=()
if [ "$#" -gt 0 ]; then
    EXTENSION_IDS=("$@")
elif [ -n "${NEURAL_JANITOR_EXTENSION_IDS:-}" ]; then
    IFS=',' read -r -a EXTENSION_IDS <<< "$NEURAL_JANITOR_EXTENSION_IDS"
elif [ -n "${NEURAL_JANITOR_EXTENSION_ID:-}" ]; then
    EXTENSION_IDS=("$NEURAL_JANITOR_EXTENSION_ID")
elif [ -n "${SMART_TAB_HYGIENE_EXTENSION_ID:-}" ]; then
    EXTENSION_IDS=("$SMART_TAB_HYGIENE_EXTENSION_ID")
elif [ -n "${MIMO_EXTENSION_ID:-}" ]; then
    EXTENSION_IDS=("$MIMO_EXTENSION_ID")
fi

FILTERED_EXTENSION_IDS=()
for raw_id in "${EXTENSION_IDS[@]}"; do
    ext_id="${raw_id//[[:space:]]/}"
    if [ -n "$ext_id" ] && [ "$ext_id" != "REPLACE_WITH_EXTENSION_ID" ]; then
        FILTERED_EXTENSION_IDS+=("$ext_id")
    fi
done

EXTENSION_IDS=("${FILTERED_EXTENSION_IDS[@]}")

if [ "${#EXTENSION_IDS[@]}" -eq 0 ]; then
    err "Missing extension id."
    err "Usage: ./scripts/install.sh <chrome-extension-id> [edge-extension-id]"
    err "Or set NEURAL_JANITOR_EXTENSION_IDS=chrome-id,edge-id"
    exit 1
fi

# ── Colours ────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[Neural-Janitor]${NC} $*"; }
ok()    { echo -e "${GREEN}[Neural-Janitor]${NC} $*"; }
warn()  { echo -e "${YELLOW}[Neural-Janitor]${NC} $*"; }
err()   { echo -e "${RED}[Neural-Janitor]${NC} $*" >&2; }

# ── Step 1: Build the companion ────────────────────────────────────

if [ -n "$PREBUILT_BINARY" ]; then
    info "Using prebuilt NeuralJanitorCompanion: $PREBUILT_BINARY"
    if [ ! -f "$PREBUILT_BINARY" ]; then
        err "Prebuilt binary not found: $PREBUILT_BINARY"
        exit 1
    fi
    BUILD_BINARY="$PREBUILT_BINARY"
else
    info "Building NeuralJanitorCompanion..."
    cd "$COMPANION_DIR"

    if ! command -v swift &>/dev/null; then
        err "Swift not found. Install Xcode/Command Line Tools, or set NEURAL_JANITOR_COMPANION_BINARY=/path/to/NeuralJanitorCompanion."
        exit 1
    fi

    swift build -c release 2>&1 | tail -5
    BUILD_BINARY="$COMPANION_DIR/.build/release/NeuralJanitorCompanion"
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
ALLOWED_ORIGINS=""
for ext_id in "${EXTENSION_IDS[@]}"; do
    origin="    \"chrome-extension://$ext_id/\""
    if [ -z "$ALLOWED_ORIGINS" ]; then
        ALLOWED_ORIGINS="$origin"
    else
        ALLOWED_ORIGINS="$ALLOWED_ORIGINS,
$origin"
    fi
done
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Neural-Janitor Companion — The Chronos Engine idle prediction via Core ML",
  "path": "$BINARY_PATH",
  "type": "stdio",
  "allowed_origins": [
$ALLOWED_ORIGINS  ]
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
info "3. Native Messaging allowed origins:"
for ext_id in "${EXTENSION_IDS[@]}"; do
info "   • chrome-extension://$ext_id/"
done
info ""
info "   If Chrome and Edge show different ids, rerun the script with both ids."
info ""
info "4. Restart the browser"
info ""
info "5. The companion will start automatically when the extension"
info "   connects. Check logs at:"
info "   ~/Library/Application Support/Neural-Janitor/companion.log"
info "═══════════════════════════════════════════════════════════"

ok "Installation complete!"
