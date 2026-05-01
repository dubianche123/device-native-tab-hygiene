#!/usr/bin/env bash
# Neural-Janitor - Import portable local model bundle
#
# Usage:
#   scripts/import_model_bundle.sh ~/Desktop/neural-janitor-model-bundle.tar.gz
#   scripts/import_model_bundle.sh --with-events ~/Desktop/neural-janitor-model-bundle.tar.gz

set -euo pipefail

APP_SUPPORT="${NEURAL_JANITOR_APP_SUPPORT_DIR:-$HOME/Library/Application Support/Neural-Janitor}"
INCLUDE_EVENTS=0
INPUT=""

usage() {
    cat <<'USAGE'
Neural-Janitor model bundle import

Options:
  --app-support PATH   Override the Neural-Janitor Application Support directory.
  --with-events        Also import raw activity_events.json training history.
  -h, --help           Show this help.

Examples:
  scripts/import_model_bundle.sh ~/Desktop/neural-janitor-model-bundle-20260501-101500.tar.gz
  scripts/import_model_bundle.sh --with-events ~/Desktop/neural-janitor-model-bundle-20260501-101500.tar.gz
USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --app-support)
            if [ "$#" -lt 2 ]; then
                echo "[Neural-Janitor] Missing value for $1" >&2
                exit 1
            fi
            APP_SUPPORT="$2"
            shift 2
            continue
            ;;
        --with-events)
            INCLUDE_EVENTS=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            if [ -z "$INPUT" ]; then
                INPUT="$1"
            else
                echo "[Neural-Janitor] Unknown argument: $1" >&2
                usage >&2
                exit 1
            fi
            ;;
    esac
    shift
done

if [ -z "$INPUT" ]; then
    usage >&2
    exit 1
fi

if [ -z "$APP_SUPPORT" ]; then
    echo "[Neural-Janitor] Empty app support path" >&2
    exit 1
fi

if [ ! -e "$INPUT" ]; then
    echo "[Neural-Janitor] Bundle not found: $INPUT" >&2
    exit 1
fi

WORKDIR="$(mktemp -d)"
cleanup() {
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

if [ -d "$INPUT" ]; then
    BUNDLE_DIR="$INPUT"
else
    tar -xzf "$INPUT" -C "$WORKDIR"
    CHECKSUM_FILE="$(find "$WORKDIR" -maxdepth 3 -type f -name SHA256SUMS -print -quit)"
    if [ -z "$CHECKSUM_FILE" ]; then
        echo "[Neural-Janitor] Invalid bundle: SHA256SUMS not found" >&2
        exit 1
    fi
    BUNDLE_DIR="$(dirname "$CHECKSUM_FILE")"
fi

if [ -f "$BUNDLE_DIR/SHA256SUMS" ]; then
    (
        cd "$BUNDLE_DIR"
        shasum -a 256 -c SHA256SUMS
    )
else
    echo "[Neural-Janitor] Warning: SHA256SUMS missing; importing without checksum verification" >&2
fi

IMPORT_FILES=(
    "TabIdlePredictor.mlmodel"
    "idle_lookup.json"
    "model_metrics.json"
)

if [ "$INCLUDE_EVENTS" -eq 1 ]; then
    IMPORT_FILES+=("activity_events.json")
fi

AVAILABLE_IMPORTS=()
for file in "${IMPORT_FILES[@]}"; do
    if [ -e "$BUNDLE_DIR/$file" ]; then
        AVAILABLE_IMPORTS+=("$file")
    fi
done

if [ "${#AVAILABLE_IMPORTS[@]}" -eq 0 ]; then
    echo "[Neural-Janitor] No requested import files found in bundle." >&2
    if [ -e "$BUNDLE_DIR/activity_events.json" ] && [ "$INCLUDE_EVENTS" -eq 0 ]; then
        echo "[Neural-Janitor] Bundle contains activity_events.json; rerun with --with-events if you intentionally want raw training history." >&2
    fi
    exit 1
fi

mkdir -p "$APP_SUPPORT"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_SUPPORT/backups/model-import-$STAMP"
mkdir -p "$BACKUP_DIR"
BACKED_UP=0

for file in "TabIdlePredictor.mlmodel" "idle_lookup.json" "model_metrics.json" "activity_events.json"; do
    current="$APP_SUPPORT/$file"
    if [ -e "$current" ]; then
        cp -R "$current" "$BACKUP_DIR/$file"
        BACKED_UP=1
    fi
done

if [ "$BACKED_UP" -eq 1 ]; then
    echo "[Neural-Janitor] Backed up existing artifacts to:"
    echo "  $BACKUP_DIR"
else
    rmdir "$BACKUP_DIR"
fi

for file in "${AVAILABLE_IMPORTS[@]}"; do
    cp -R "$BUNDLE_DIR/$file" "$APP_SUPPORT/$file"
done

echo "[Neural-Janitor] Imported model bundle into:"
echo "  $APP_SUPPORT"
echo
echo "[Neural-Janitor] Imported files:"
for file in "${AVAILABLE_IMPORTS[@]}"; do
    echo "  - $file"
done

if [ -e "$BUNDLE_DIR/activity_events.json" ] && [ "$INCLUDE_EVENTS" -eq 0 ]; then
    echo
    echo "[Neural-Janitor] activity_events.json was present but not imported. Use --with-events only when you want to restore raw training history."
fi

echo
echo "[Neural-Janitor] Restart Chrome/Edge, or reload the extension, so the companion reloads the imported artifacts."
