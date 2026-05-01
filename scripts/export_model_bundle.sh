#!/usr/bin/env bash
# Neural-Janitor - Export portable local model bundle
#
# Usage:
#   scripts/export_model_bundle.sh
#   scripts/export_model_bundle.sh --output ~/Desktop
#   scripts/export_model_bundle.sh --with-events --output ~/Desktop/nj-model.tar.gz
#
# By default this exports only the transferable model artifacts. Raw activity
# history is privacy-sensitive and is exported only when --with-events is set.

set -euo pipefail

APP_SUPPORT="${NEURAL_JANITOR_APP_SUPPORT_DIR:-$HOME/Library/Application Support/Neural-Janitor}"
OUTPUT=""
INCLUDE_EVENTS=0

usage() {
    cat <<'USAGE'
Neural-Janitor model bundle export

Options:
  -o, --output PATH    Output .tar.gz path, or a directory to place it in.
  --app-support PATH   Override the Neural-Janitor Application Support directory.
  --with-events        Include raw activity_events.json training history.
  -h, --help           Show this help.

Default output:
  ~/Desktop/neural-janitor-model-bundle-YYYYMMDD-HHMMSS.tar.gz
USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -o|--output)
            if [ "$#" -lt 2 ]; then
                echo "[Neural-Janitor] Missing value for $1" >&2
                exit 1
            fi
            OUTPUT="$2"
            shift 2
            continue
            ;;
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
            if [ -z "$OUTPUT" ]; then
                OUTPUT="$1"
            else
                echo "[Neural-Janitor] Unknown argument: $1" >&2
                usage >&2
                exit 1
            fi
            ;;
    esac
    shift
done

if [ -z "$APP_SUPPORT" ] || [ ! -d "$APP_SUPPORT" ]; then
    echo "[Neural-Janitor] App support directory not found: $APP_SUPPORT" >&2
    exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BUNDLE_NAME="neural-janitor-model-bundle-$STAMP"

if [ -z "$OUTPUT" ]; then
    OUTPUT="$HOME/Desktop/$BUNDLE_NAME.tar.gz"
elif [ -d "$OUTPUT" ]; then
    OUTPUT="$OUTPUT/$BUNDLE_NAME.tar.gz"
fi

mkdir -p "$(dirname "$OUTPUT")"

WORKDIR="$(mktemp -d)"
cleanup() {
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

BUNDLE_DIR="$WORKDIR/Neural-Janitor-Model-Bundle"
mkdir -p "$BUNDLE_DIR"

TRANSFER_FILES=(
    "TabIdlePredictor.mlmodel"
    "idle_lookup.json"
    "model_metrics.json"
)

if [ "$INCLUDE_EVENTS" -eq 1 ]; then
    TRANSFER_FILES+=("activity_events.json")
fi

INCLUDED_FILES=()
for file in "${TRANSFER_FILES[@]}"; do
    source="$APP_SUPPORT/$file"
    if [ -e "$source" ]; then
        cp -R "$source" "$BUNDLE_DIR/$file"
        INCLUDED_FILES+=("$file")
    fi
done

if [ "${#INCLUDED_FILES[@]}" -eq 0 ]; then
    echo "[Neural-Janitor] No transferable artifacts found in: $APP_SUPPORT" >&2
    echo "[Neural-Janitor] Open the extension and let the companion collect/train first, or run scripts/train_model.py." >&2
    exit 1
fi

(
    cd "$BUNDLE_DIR"
    shasum -a 256 "${INCLUDED_FILES[@]}" > SHA256SUMS
)

{
    echo "# Neural-Janitor Model Bundle"
    echo
    echo "- Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "- Source: $APP_SUPPORT"
    echo "- Raw activity history included: $([ "$INCLUDE_EVENTS" -eq 1 ] && echo yes || echo no)"
    echo
    echo "## Included Files"
    echo
    for file in "${INCLUDED_FILES[@]}"; do
        echo "- \`$file\`"
    done
    echo
    echo "## Import"
    echo
    echo "On the target Mac:"
    echo
    echo '```bash'
    echo "scripts/import_model_bundle.sh \"$BUNDLE_NAME.tar.gz\""
    echo '```'
    echo
    echo "If this bundle includes \`activity_events.json\` and you intentionally want to restore raw training history:"
    echo
    echo '```bash'
    echo "scripts/import_model_bundle.sh --with-events \"$BUNDLE_NAME.tar.gz\""
    echo '```'
} > "$BUNDLE_DIR/MANIFEST.md"

tar -czf "$OUTPUT" -C "$WORKDIR" "Neural-Janitor-Model-Bundle"

echo "[Neural-Janitor] Exported model bundle:"
echo "  $OUTPUT"
echo
echo "[Neural-Janitor] Included files:"
for file in "${INCLUDED_FILES[@]}"; do
    echo "  - $file"
done

if [ "$INCLUDE_EVENTS" -eq 0 ] && [ -e "$APP_SUPPORT/activity_events.json" ]; then
    echo
    echo "[Neural-Janitor] activity_events.json was not included. Use --with-events only if you want to move raw browsing history."
fi
