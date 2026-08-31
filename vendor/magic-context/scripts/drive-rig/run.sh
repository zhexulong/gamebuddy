#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SNAPSHOT=${DRIVE_RIG_SNAPSHOT:-"$HOME/.cache/mc-drive-rig/snapshot"}
CONNECTION_FILE=${DRIVE_RIG_CONNECTION_FILE:-"$HOME/.local/share/cortexkit/run/subc-connection.json"}
IMAGE=${DRIVE_RIG_IMAGE:-mc-drive:1.18.3}
CONTAINER=${DRIVE_RIG_CONTAINER:-mc-drive}

if ! command -v docker >/dev/null 2>&1; then
    printf 'required command is missing: docker\n' >&2
    exit 1
fi
if [[ ! -d "$SNAPSHOT/repo" || ! -f "$SNAPSHOT/home/.local/share/opencode/opencode.db" ]]; then
    printf 'snapshot is not prepared: %s\n' "$SNAPSHOT" >&2
    exit 1
fi
if [[ ! -r "$CONNECTION_FILE" ]]; then
    printf 'connection file is not readable: %s\n' "$CONNECTION_FILE" >&2
    exit 1
fi

resolve_opencode() {
    if command -v opencode >/dev/null 2>&1; then
        command -v opencode
    elif [[ -x "$HOME/.opencode/bin/opencode" ]]; then
        printf '%s\n' "$HOME/.opencode/bin/opencode"
    else
        printf 'host opencode executable was not found\n' >&2
        exit 1
    fi
}

host_opencode=$(resolve_opencode)
host_version=$("$host_opencode" --version)
if [[ -z "$host_version" ]]; then
    printf 'host opencode did not report a version\n' >&2
    exit 1
fi

printf 'building %s for linux/arm64 with OpenCode %s\n' "$IMAGE" "$host_version"
docker build \
    --platform linux/arm64 \
    --build-arg "OPENCODE_VERSION=$host_version" \
    -t "$IMAGE" \
    "$SCRIPT_DIR"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

printf 'starting %s\n' "$CONTAINER"
docker run -d \
    --name "$CONTAINER" \
    --platform linux/arm64 \
    --cpus=4 \
    --memory=8g \
    --add-host=host.docker.internal:host-gateway \
    -v "$SNAPSHOT:$SNAPSHOT:rw" \
    -v "$CONNECTION_FILE:$CONNECTION_FILE:ro" \
    -e HOME="$SNAPSHOT/home" \
    -e XDG_DATA_HOME="$SNAPSHOT/home/.local/share" \
    -e XDG_CONFIG_HOME="$SNAPSHOT/home/.config" \
    -e XDG_CACHE_HOME="$SNAPSHOT/home/.cache" \
    -e MAGIC_CONTEXT_LOG_PATH="$SNAPSHOT/magic-context.log" \
    -e SUBC_CONNECTION_FILE="$CONNECTION_FILE" \
    -e DRIVE_REPO="$SNAPSHOT/repo" \
    "$IMAGE"

printf 'container started: %s\n' "$CONTAINER"
printf 'attach with: docker exec -it %s tmux attach -t drive\n' "$CONTAINER"
