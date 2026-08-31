# Isolated Docker drive rig

This rig drives a cloned OpenCode session without opening the host databases in the container. The snapshot is the container's writable data volume. The host databases, auth file, config files, and repository are read only inputs to `prepare.sh`, and the subc connection file is the only additional read-only mount at runtime.

The image targets `linux/arm64`. It installs OpenCode from the official installer with the exact version reported by the host binary. The image does not copy the macOS binary and does not install subc or broca.

## Prerequisites

The host needs Bash, `jq`, `sqlite3`, Docker, and a working `opencode` executable. The standard install location `$HOME/.opencode/bin/opencode` is accepted even when it is not on `PATH`. The plugin distribution must already exist at `packages/plugin/dist` in this checkout.

The default source paths are:

- OpenCode database: `~/.local/share/opencode/opencode.db`
- Magic Context database: `~/.local/share/cortexkit/magic-context/context.db`
- OpenCode auth: `~/.local/share/opencode/auth.json`
- Magic Context config: `~/.config/cortexkit/magic-context.jsonc`
- OpenCode config directory: `~/.config/opencode/`
- Benchmark repository: `~/Work/Projects/CortexKit/benchmarks`
- subc connection file: `~/.local/share/cortexkit/run/subc-connection.json`

Override the snapshot, benchmark, plugin distribution, connection, and session paths with `DRIVE_RIG_SNAPSHOT`, `DRIVE_RIG_BENCHMARKS`, `DRIVE_RIG_PLUGIN_DIST`, `DRIVE_RIG_CONNECTION_FILE`, and `DRIVE_RIG_SESSION_ID` when needed.

## Flow

Run these commands from the repository checkout:

```sh
scripts/drive-rig/prepare.sh
scripts/drive-rig/run.sh
scripts/drive-rig/verify.sh
docker exec -it mc-drive tmux attach -t drive
```

`prepare.sh` removes and rebuilds `~/.cache/mc-drive-rig/snapshot/`. It copies both databases with SQLite `VACUUM INTO`, preserving the requested session without copying a live WAL database. It copies auth and config data, keeps the `subc` block, rewrites the Magic Context plugin entry to `/snapshot/plugin-dist/index.js`, prunes dead file-path plugin references for host-only auth, aft, and other plugins, and copies the ignored benchmark `.cortexkit` directory explicitly. The connection path is rewritten to the host absolute path so the container can use the read-only bind mount.

`run.sh` builds the image, removes any previous `mc-drive` container, and starts a replacement with four CPUs and 8 GiB of memory. The snapshot is the only writable volume. The connection file is mounted read only at its same absolute path. `HOME`, XDG data, config, and cache paths point into the snapshot. Docker Desktop's `host.docker.internal` is enabled with the host gateway flag.

The container entrypoint reads the port from the mounted connection file and starts one loopback TCP forwarder:

```text
127.0.0.1:<port> in the container -> host.docker.internal:<port>
```

No host bridge process or Unix socket is created. The host daemon remains the owner of the loopback service and the connection file stays current if its port or key changes.

`verify.sh` checks the container and tmux session, proves that Docker has exactly two mounts with the snapshot writable and the connection file read only, compares the host and container OpenCode versions, probes the forwarded subc port, launches `opencode -s ses_OqknfoW2O3LTOcjLvOMQoREVPtz1` inside tmux, waits for the TUI to boot, sends `reply with exactly OK`, and waits for the internal `rust pass:` log line. It prints the mount JSON and the observed rust log line.

## Cleanup

The next `run.sh` invocation removes the existing container. To remove it manually:

```sh
docker rm -f mc-drive
```
