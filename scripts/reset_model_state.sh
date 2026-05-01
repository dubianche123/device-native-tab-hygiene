#!/usr/bin/env bash
# Neural-Janitor - Reset local learning state
#
# This clears the companion's local idle model artifacts and queues a reset
# request so the browser extension can clear closure-learning state on the
# next health sync.
#
# Usage:
#   scripts/reset_model_state.sh
#   scripts/reset_model_state.sh --app-support ~/Library/Application\ Support/Neural-Janitor

set -euo pipefail

APP_SUPPORT="${NEURAL_JANITOR_APP_SUPPORT_DIR:-$HOME/Library/Application Support/Neural-Janitor}"
BINARY="${NEURAL_JANITOR_COMPANION_BINARY:-$HOME/.local/bin/NeuralJanitorCompanion}"

usage() {
    cat <<'USAGE'
Neural-Janitor model-state reset

Options:
  --app-support PATH   Override the Neural-Janitor Application Support directory.
  -h, --help           Show this help.

This command asks the companion to clear its local idle model artifacts and
queues a browser-state reset for the next extension sync.
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
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "[Neural-Janitor] Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [ ! -x "$BINARY" ]; then
    echo "[Neural-Janitor] Companion binary not found: $BINARY" >&2
    echo "[Neural-Janitor] Run scripts/install.sh <extension-id> first, or set NEURAL_JANITOR_COMPANION_BINARY." >&2
    exit 1
fi

NEURAL_JANITOR_APP_SUPPORT_DIR="$APP_SUPPORT" "$BINARY" --reset-learning
echo "[Neural-Janitor] Reset requested. Reload the extension or open the popup so the browser-side learning state is cleared too."
