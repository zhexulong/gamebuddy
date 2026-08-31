# Context database migration version lanes

The shared `context.db` migration bookkeeping uses two reserved ranges:

- Upstream Magic Context migrations use versions below `10000`.
- Downstream forks and sibling plugins sharing `context.db` use versions `10000` and above.

The boundary isolates migration **bookkeeping** only. A fork's DDL must remain compatible with the upstream tables; version ranges cannot make incompatible DDL safe. Multiple sibling forks must coordinate their own subranges. Magic Context provides one downstream lane, not an allocator.

A fork that does not use the downstream range continues to be treated like stock, so it gets today's status quo, not worse. Rows inserted by hand at versions `>= 10000` are fence-invisible by design, so upstream schema fences and probes report only the upstream lane. Migration pendingness checks each candidate in the pending upstream range directly, preserving downstream rows while shared-core migrations run.

The `crates/mc-store` migration chain is out of scope: it uses a separate database with namespace-keyed primary keys and already has its own owner design.
