# Incremental native attachment cache design (2026-08-10)

## Cache shape and frontier

`McHandler` owns one 64 MiB process-local LRU budget shared by all cached sessions. A session entry is fenced by the durable `revert_epoch` and stores:

- the last acknowledged full-array fingerprint;
- an `Arc<DecodeSidecar>` whose unchanged prefix metadata is also shared through `Arc`;
- one native cache key per served CK message;
- encoded OpenCode chunks as `Arc<Value>`, including each chunk's consumed CK range;
- per-message sidecar digests and hit/miss counters;
- an `Arc<FlatProjection>` with per-message block ends and projector frontier state.

The projection and native attachment are two consumers of the same session snapshot, fingerprint, context, revert-epoch fence, LRU, and eviction. A tail delta may reuse the projected prefix only after the prior transform snapshot and this shared cache entry both acknowledge the same `after` fingerprint. The cached projector frontier carries pending tool-call arcs across the first changed message. Prefix `FlatBlock` clones share their canonical bytes, CK wire, and tool input through `Arc`, so reconstruction copies only small metadata rather than the retained payload trees.

A tail delta may reuse sidecar metadata only when its validated `after` fingerprint matches the cache entry and its `native_replace_from` frontier is in range. Full-array requests re-read and hash their sidecar metadata even when the opaque fingerprint repeats, so a message metadata mutation cannot hide behind a stale caller fingerprint.

Full-array requests always project every message. Validated tail deltas project only at or after `replace_from`; the message/block frontier maps the caller's message position to a flat-block prefix without scanning payloads. The first changed served-message key determines the suffix to encode. The restart point backs up one CK message and then snaps to the beginning of the containing encoded chunk. This preserves adjacent fresh tool pairs and collapsed synthetic todo pairs. Cached prefix values are shared by `Arc`; only suffix values are allocated and encoded. The whole combined array still passes the duplicate-tool-use assertion.

## Key fields

The session context key contains:

- session id;
- serializer profile and profile render epoch;
- render configuration;
- renderer transition-consumed salt.

Each served-message key hashes:

- the serialized-output cache identity produced by `message_output_identity` for tail messages;
- the canonical CK message hash as a byte-level backstop;
- served position;
- full sidecar/message metadata digest;
- message tag number;
- reasoning-clear eligibility;
- mutation-exemption state for the live assistant or lineage anchor.

The sidecar digest covers retained raw OpenCode fields and block metadata, not only CK-visible content. Incremental suffix decoding calls the ordinary decoder with the prior sidecar, so the decoder first clones all prior `mid_pins` and then adds suffix pins. Assigning the resulting pin map to the merged sidecar therefore preserves prior pins; there is no separate merge with a conflicting value. A three-generation regression compares this behavior with a full decode and proves that clearing inherited pins produces a different identity.

## Budget accounting and RSS bound

The 64 MiB limit bounds the cache's **charged estimate**, not process RSS. For each retained session the charge is `E + 2S + N + P`:

- `E` is the recursive retained-size estimate for encoded native `Value` chunks;
- `S` is the canonical served-CK byte count; `2S` conservatively proxies the served-message objects and shared canonical storage;
- `N` is the sidecar charge: twice each serialized message-meta size plus the meta struct, sidecar map/order/pin string payloads, and the sidecar struct itself. Prefix `N` values are reused and suffix values are computed alongside the existing sidecar hash.
- `P` is the projected-prefix charge: each `FlatBlock` struct and owned identity string, three times its serialized CK-block byte length (canonical string, CK tree, and separately retained tool input), the block-identity map, message/block ends, and pending tool-arc frontier strings. The third copy is conservative for blocks without tool input.

The limit does not precisely charge allocator bucket/capacity overhead, `Arc`/map node overhead, transient serialization buffers, or every non-string container allocation. During replacement, the old snapshot and new snapshot can coexist until the request-local old snapshot drops; unchanged `Arc` data is shared, but changed trees can temporarily exist twice. Operationally, use **4× the configured budget as a conservative RSS headline** (256 MiB for the default 64 MiB) for this cache during replacement. That multiplier is guidance, not an enforced memory ceiling.

## Invalidation matrix

| Change | Native attachment fence | Projected-prefix effect |
| --- | --- | --- |
| Fold or m0/m1 byte change | Canonical message hash; changed prefix position restarts encoding | Ingress CK is unchanged, so projection remains valid for this pass; the shared entry is replaced with the newly served snapshot afterward. |
| Coverage advance/removal | Message sequence/position mismatch | Coverage is downstream state, not an ingress projection input; shared-entry replacement still keeps both consumers on the latest acknowledged pass. |
| Frozen reduction or reasoning healing | Serialized-output identity plus canonical hash | These mutate served output after projection; the cached ingress prefix is byte-identical and the differential compares the complete projection. |
| Synthetic todo insertion, move, replacement, or removal | Message sequence keys and chunk-boundary restart | Ingress synthetic metadata/content is projected, so a changed `replace_from` suffix is re-projected; unchanged reconstructed prefix comes from the acknowledged request. |
| Renderer transition salt | Session context key | The same context key gates projected reuse. Transition state discovered during this pass affects rendering, not ingress projection, and replaces the shared entry afterward. |
| Durable revert epoch | Session entry eviction | Same session-entry eviction. |
| Render/profile epoch or profile change | Session context key | Same context key; projected reuse is refused before reconstruction. |
| Tag mutation | Per-message tag number and CK output identity | Tags already present in ingress CK are covered by the changed-tail frontier. Store-only tag state is downstream and replaces the shared entry after attachment. |
| Reasoning watermark or mid-turn effect | Per-message reasoning-clear eligibility and mutation exemption | Watermarks alter served/native output after ingress projection; shared-entry replacement and the projection differential cover the distinction. |
| Sidecar/raw/provider metadata change | Per-message sidecar digest | Sidecar-only fields are not `FlatProjection` inputs; native reuse invalidates while the byte-equivalent ingress projection may still reuse. |
| Tail append/replace | Validated fingerprint frontier reuses only unchanged sidecar metadata; changed output suffix is encoded | The same fingerprint plus `replace_from` reuses only the acknowledged projected prefix and projects the suffix. |

## Differential and live observability

Tests always run a full native encode after the incremental path and compare serialized JSON bytes. Any module build, including an optimized release binary, can enable the same assertion with `MC_NATIVE_ATTACHMENT_DIFFERENTIAL=1`; the real-daemon suite does so. Incremental projection likewise serializes and byte-compares its blocks, identity map, and retained CK wire against a full projection, then compares projector frontier state. Any build can enable it with `MC_PREFIX_PROJECTION_DIFFERENTIAL=1`, and the real-daemon suite enables both modes. Each environment variable is read once per process and then cached, so the unset steady path performs only a `OnceLock` read. These are diagnostic switches: when enabled, they intentionally pay for a full native encode or full projection on every incremental pass and therefore erase the corresponding performance win. Mutation tests deliberately omit the sidecar digest from native cache-key derivation and advance the projection's first-changed frontier by one; each differential assertion fails on the resulting stale bytes. Regression coverage also exercises frozen reductions, collapsed synthetic todo pairs, compaction markers, reasoning clearing, every invalidation class, and duplicate tool-use detection.

The pass timing record retains `post_attach_ms` and `native_cache_reused_messages` / `native_cache_encoded_messages`, and adds `projection_reused_messages` / `projection_projected_messages`, allowing live traces to distinguish a genuinely incremental pass from a fast full pass.

At 2,500 messages with 4 KiB text payloads (release fixture, 2026-08-10), the pre-change decomposition was projection 24.620 ms, apply 5.830 ms, attach 2.639 ms, and encode 5.302 ms. After prefix projection, the same fixture measured full projection 24.790 ms and cached projection 0.713 ms (34.8x faster), with apply 6.161 ms, attach 2.723 ms, and encode 5.290 ms. Their 14.887 ms steady-pass sum is below the 20 ms target.
