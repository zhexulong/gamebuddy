#!/usr/bin/env bash
#
# Build + run the interactive Magic Context setup/doctor sandbox.
#
# Installs the PUBLISHED @cortexkit/magic-context (latest by default) in a clean
# container with OpenCode + Pi present, then drops you into a shell to drive the
# setup/doctor wizards by hand and inspect where config lands (the CortexKit
# location). Rebuild after a release to pick up the newest published version.
#
# Usage:
#   tests/docker/setup-sandbox.sh                  # build @latest + run shell
#   tests/docker/setup-sandbox.sh 0.27.1           # pin a specific version
#   tests/docker/setup-sandbox.sh --build-only     # just (re)build the image
#
# Driven from a PTY: build with --build-only first, then
#   docker run --rm -it --platform linux/amd64 mc-setup-sandbox
# in a PTY session so the wizard's interactive prompts work.

set -euo pipefail

IMAGE="mc-setup-sandbox"
PLATFORM="linux/amd64"
MC_VERSION="latest"
BUILD_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) MC_VERSION="$arg" ;;
  esac
done

# Resolve repo root from this script's location so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Building $IMAGE (magic-context@$MC_VERSION, fresh npm fetch)..."
docker build \
  --platform "$PLATFORM" \
  --build-arg "MC_VERSION=$MC_VERSION" \
  --build-arg "CACHE_BUST=$(date +%s)" \
  -f "$SCRIPT_DIR/Dockerfile.setup-sandbox" \
  -t "$IMAGE" \
  "$REPO_ROOT"

if [[ "$BUILD_ONLY" == "1" ]]; then
  echo "Built $IMAGE. Run interactively with:"
  echo "  docker run --rm -it --platform $PLATFORM $IMAGE"
  exit 0
fi

echo "Starting interactive shell in $IMAGE..."
exec docker run --rm -it --platform "$PLATFORM" "$IMAGE"
