#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER=${DRIVE_RIG_CONTAINER:-mc-drive}
SNAPSHOT=${DRIVE_RIG_SNAPSHOT:-"$HOME/.cache/mc-drive-rig/snapshot"}
CONNECTION_FILE=${DRIVE_RIG_CONNECTION_FILE:-"$HOME/.local/share/cortexkit/run/subc-connection.json"}
SESSION_ID=${DRIVE_RIG_SESSION_ID:-ses_OqknfoW2O3LTOcjLvOMQoREVPtz1}
LOG_PATH=${DRIVE_RIG_LOG_PATH:-$SNAPSHOT/magic-context.log}
WAIT_SECONDS=${DRIVE_RIG_WAIT_SECONDS:-180}

if ! command -v docker >/dev/null 2>&1; then
    printf 'required command is missing: docker\n' >&2
    exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
    printf 'required command is missing: jq\n' >&2
    exit 1
fi
if [[ ! -r "$CONNECTION_FILE" ]]; then
    printf 'connection file is not readable: %s\n' "$CONNECTION_FILE" >&2
    exit 1
fi
if [[ ! -d "$SNAPSHOT" ]]; then
    printf 'snapshot directory is missing: %s\n' "$SNAPSHOT" >&2
    exit 1
fi

running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)
if [[ "$running" != true ]]; then
    printf 'container is not running: %s\n' "$CONTAINER" >&2
    exit 1
fi

tmux_ready=false
for ((elapsed = 0; elapsed < 30; elapsed++)); do
    if docker exec "$CONTAINER" tmux has-session -t drive 2>/dev/null; then
        tmux_ready=true
        break
    fi
    sleep 1
done
if [[ "$tmux_ready" != true ]]; then
    printf 'tmux drive session did not start\n' >&2
    exit 1
fi
echo 'container running: passed'
echo 'tmux drive session: passed'

snapshot_path=$(cd -- "$SNAPSHOT" && pwd -P)
connection_path=$(cd -- "$(dirname -- "$CONNECTION_FILE")" && pwd -P)/$(basename -- "$CONNECTION_FILE")
mounts_json=$(docker inspect -f '{{json .Mounts}}' "$CONTAINER")
if ! jq -e \
    --arg snapshot "$snapshot_path" \
    --arg connection "$connection_path" \
    'length == 2
     and any(.[]; .Source == $snapshot and .Destination == "/snapshot" and .RW == true)
     and any(.[]; .Source == $connection and .Destination == $connection and .RW == false)' \
    <<<"$mounts_json" >/dev/null; then
    printf 'container mounts do not prove isolation; expected exactly snapshot rw and connection ro\n' >&2
    printf 'mounts JSON: %s\n' "$mounts_json" >&2
    exit 1
fi
printf 'mounts JSON: %s\n' "$mounts_json"
echo 'structural host isolation: passed'

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
container_version=$(docker exec "$CONTAINER" opencode --version)
if [[ "$container_version" != "$host_version" ]]; then
    printf 'OpenCode version mismatch: host=%s container=%s\n' "$host_version" "$container_version" >&2
    exit 1
fi
printf 'OpenCode version: %s, matches host\n' "$container_version"

subc_port=$(jq -er '(.port // .endpoints[0].port) | numbers' "$CONNECTION_FILE")
docker exec "$CONTAINER" sh -c \
    "socat -T 2 -u /dev/null TCP4:127.0.0.1:${subc_port}"
echo "subc bridge TCP probe on port ${subc_port}: passed"

docker exec "$CONTAINER" sh -c "rm -f '$LOG_PATH'"
docker exec "$CONTAINER" tmux send-keys -t drive C-c
sleep 1
docker exec "$CONTAINER" tmux send-keys -t drive "opencode -s $SESSION_ID" C-m
printf 'launched opencode -s %s inside tmux\n' "$SESSION_ID"
sleep 20
docker exec "$CONTAINER" tmux send-keys -t drive "reply with exactly OK"
sleep 1
docker exec "$CONTAINER" tmux send-keys -t drive C-m
printf 'sent turn prompt: reply with exactly OK\n'

rust_line=''
for ((elapsed = 0; elapsed < WAIT_SECONDS; elapsed++)); do
    rust_line=$(docker exec "$CONTAINER" sh -c \
        "grep -F '[${SESSION_ID}] rust pass:' '$LOG_PATH' 2>/dev/null | tail -n 1" || true)
    if [[ -n "$rust_line" ]]; then
        break
    fi
    sleep 1
done

if [[ -z "$rust_line" ]]; then
    printf 'rust pass log line was not observed inside the container after %s seconds\n' "$WAIT_SECONDS" >&2
    printf 'tmux capture:\n' >&2
    docker exec "$CONTAINER" tmux capture-pane -t drive -p >&2 || true
    printf 'Magic Context log tail:\n' >&2
    docker exec "$CONTAINER" sh -c "tail -n 80 '$LOG_PATH' 2>/dev/null" >&2 || true
    exit 1
fi

printf 'rust pass log line inside container: %s\n' "$rust_line"
echo 'drive rig verification: passed'
