#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Smart Tab Hygiene — Uninstall Native Messaging Host
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

HOST_NAMES=("com.smarttabhygiene.companion" "com.mimo.companion")
BINARY_PATHS=("$HOME/.local/bin/SmartTabHygieneCompanion" "$HOME/.local/bin/MimoCompanion")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[Smart Tab Hygiene]${NC} $*"; }
ok()    { echo -e "${GREEN}[Smart Tab Hygiene]${NC} $*"; }
warn()  { echo -e "${YELLOW}[Smart Tab Hygiene]${NC} $*"; }

# Remove binary
for binary in "${BINARY_PATHS[@]}"; do
    if [ -f "$binary" ]; then
        rm "$binary"
        ok "Removed binary: $binary"
    else
        warn "Binary not found: $binary"
    fi
done

# Remove manifests from all known browser directories
MANIFEST_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge Beta/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge Dev/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge Canary/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

for dir in "${MANIFEST_DIRS[@]}"; do
    for host in "${HOST_NAMES[@]}"; do
        manifest="$dir/$host.json"
        if [ -f "$manifest" ]; then
            rm "$manifest"
            ok "Removed: $manifest"
        fi
    done
done

# Optionally remove app data
DATA_DIR="$HOME/Library/Application Support/Smart Tab Hygiene"
LEGACY_DATA_DIR="$HOME/Library/Application Support/Mimo"
if [ -d "$DATA_DIR" ] || [ -d "$LEGACY_DATA_DIR" ]; then
    read -p "Remove Smart Tab Hygiene data directories? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$DATA_DIR" "$LEGACY_DATA_DIR"
        ok "Removed data directory"
    else
        info "Data directory preserved"
    fi
fi

ok "Uninstallation complete"
