# Rust transform performance round 4 (2026-08-16)

## Measurement method

The profile used `VACUUM INTO` copies of the live OpenCode and Magic Context databases. The copies, project clones, module state, logs, and OpenCode XDG directories lived under this task worktree and were deleted after the run. The source databases were opened read-only and were never passed to OpenCode or the module.

The rig used the existing `HermeticSubcStack`, the release `ck-mc` binary, an isolated OpenCode server, and the E2E mock provider. The measured ENGRAM session had 4,575 ingress messages and 12,330 projected blocks before the profile turns. Each warm turn appended a small user/assistant tail. Differential assertions remained enabled in tests but were disabled in the timing binary because they intentionally repeat full projection and native encoding.

## Measured cost centers before changing the hot paths

A steady delta pass on the isolated ENGRAM copy showed that the retained projection was working, but several downstream consumers still traversed the complete history.

| Stage | Before (ms) | Evidence |
| --- | ---: | --- |
| Handler total | 675.9 | Entire module handler, the value represented by the plugin's module bracket |
| `apply_once` | 495.2 | Core transform |
| Projection | 4.6 | 4,578 reused messages, 3 projected messages |
| Planning | 37.1 | Included protected-tag evaluation over the full projection |
| State evolution | 346.4 | Dominated by repeated tool-arc searches and tokenization |
| Build output | 34.7 | Output cache hit for all but the changed tail |
| Historian trigger | 26.2 | 12,284 token-cache hits, 3 tokenized blocks |
| Native attachment | 49.4 | 4,519 reused native messages, 5 encoded messages |
| Retained-size accounting | 41.5 | Rewalked retained request/native trees |
| Response encode | 21.4 | Encoded the complete native output despite a tiny changed tail |

The ASTRO copy (about 5,670 messages and 17,940 blocks) also exposed the output-cache refusal mode: a steady pass had zero cache hits, 5,650 serialization misses, `build_output=295.0ms`, `apply_once=976.5ms`, and `handler_total=1120.2ms`. The old 64 MiB output-cache ceiling could not retain that single real session.

The main algorithmic defect was in channel directive accounting. For every eligible tool result, `channel2_extra_token_lanes` rescanned the full projection and retokenized matching tool input and reasoning. Frozen reduction checks also linearly scanned every frozen unit once per candidate block. Both paths were quadratic on real histories even though projection itself was incremental.

## Changes

1. The one-line `mc-pass-timing` record now covers handler ingress, delta expansion, projection-cache lookup/store, historian boundary construction/evaluation, native attachment, retained-size accounting, snapshot storage, response metadata encoding/size accounting/splicing, and core planning/state/finalization subphases. The plugin logs the corresponding module fields.
2. Channel directive accounting is linear. Frozen targets are indexed once, tool-arc token lanes are accumulated once, and each `FlatBlock` retains its tool-input/reasoning token counts. Incremental projection therefore tokenizes only changed suffix blocks.
3. The serialized-output cache budget is 256 MiB so a 24-55 MiB real output plus its typed CK representation can remain resident. `ServedMessage` computes its retained-size charge once when serialized; cache replacement no longer walks every served tree.
4. Warm native responses use a fingerprint-fenced replacement suffix. The adapter retains the prior acknowledged module output by reference and reconstructs the exact full output before validation/postprocessing. Missing cache state, a fingerprint mismatch, or an invalid frontier fails closed instead of applying a suffix to the wrong prefix.
5. Native attachment takes ownership of the prior cache snapshot instead of deep-cloning its maps and trees. Sidecar hashes/sizes and ingress retained-size charges are reused; only suffix entries are computed. Snapshot request accounting similarly reuses per-message and native prefix charges.
6. Boundary token cache snapshots share immutable maps and record suffix updates. On the ordinary single-flight path replacement takes ownership rather than cloning every key. Same-length content edits remain fenced by the projected content hash.
7. `full_drop_tool_ids` indexes tool-call kinds once, and build-output indexing retains only message IDs that can be emitted.
8. Memory and compartment mirrors run asynchronously, sequentially, and with the existing memory-pull coalescer. Their results are not read by the serving pass. A 141 ms isolated pull completed after the pass; it no longer extended the transform promise. The same change bounds the reported 1.5 s backlog spikes off the hot path.

## After table

The final steady ENGRAM delta used 4,576 retained messages plus a 3-message suffix. It reused 4,519 output-cache entries, re-encoded 5 native messages, and tokenized 3 historian blocks.

| Stage | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Handler total | 675.9 | **149.5** |
| `apply_once` | 495.2 | **75.0** |
| Delta expansion | 39.9 | 21.8 |
| Projection | 4.6 | 3.0 |
| Planning | 37.1 | 5.8 |
| State evolution | 346.4 | 14.3 |
| Build output | 34.7 | 18.2 |
| Historian trigger | 26.2 | 14.2 |
| Native attachment | 49.4 | 25.4 |
| Retained-size accounting | 41.5 | **0.0** |
| Response encode | 21.4 | **0.6** |
| Plugin transport call | not retained in the first local table | 190.7 |

The handler improved 4.5x and the core transform is below 100 ms, but the complete release handler remains 149.5 ms on this host. This does **not** satisfy the requested sub-100 ms complete module bracket. The remaining measured floor is `apply_once=75.0`, delta reconstruction 21.8, native attachment 25.4, historian trigger 14.2, and projection-cache storage 5.7 ms (some stages overlap the handler's post-attach aggregate). Further progress requires removing the full native-prefix reconstruction from `TransformRequest`, whose `Vec<Value>` ownership currently forces deep prefix cloning before the incremental attachment code can run.

The full plugin pass was 380.5 ms in this run. Of that, 149.5 ms was the module handler, prefix guard was 8.8 ms, state sync 0.5 ms, apply 2.0 ms, LKG preparation 11.5 ms, and 166.2 ms was loaded OpenCode event-loop delay. The latter is outside the module and varied materially between repeated runs.

## Prefix corruption sentinel

A truly O(delta) deep prefix check is not sound with the current OpenCode hook API. Messages and nested tool arguments are mutable JavaScript objects and carry no trusted mutation generation. Object identity, message ID/count, byte length, and shallow timestamps all miss a same-object, same-length edit. A cached digest also has to be recomputed over the prefix unless the mutator supplies a trustworthy revision.

This change therefore does not weaken the sentinel by claiming an unsafe O(delta) fast path. The existing cache-miss fallback sends the complete array. A cache hit still compares the deep `MessageContentSnapshot` of every reused raw message at the point where a tail delta would be selected. The equal-length mutation test changes a nested tool query from `alpha` to `bravo`; the deep comparison rejects the delta and the adapter full-sends. Randomized deep mutations, key additions/removals/reordering, and nested type changes are compared against the legacy detector. On the isolated live copy the complete 4.5k-message guard measured 8.8 ms.

A future O(delta) implementation needs an OpenCode-owned immutable message revision (covering all nested `info`, `parts`, provider metadata, and tool input/output) or persistent immutable message nodes. Without that producer contract, skipping old objects changes detection semantics.

## Cold restart digest decision

A digest-only handshake is unsafe and insufficient today, so it was not implemented.

The durable module store retains compaction/cache state, but the raw CK/native ingress prefix used by delta projection and native attachment is process-local. After a serve restart, a digest match could prove that the host still has the same bytes, but it would not give the restarted module those bytes. Accepting a tail delta would therefore either fail later or serve state reconstructed without the retained raw prefix. IDs plus content lengths are additionally vulnerable to the same-length mutation demonstrated by the prefix-guard test.

A sound cold-seed design must persist, atomically with row version, revert epoch, generation, serializer/render epochs, and the digest:

- the canonical raw CK/native prefix (or an equivalent lossless projection/sidecar snapshot),
- a versioned cryptographic digest over message IDs, ordering, all content/provider metadata, and structural boundaries,
- the exact message count/frontier represented by that snapshot.

The adapter may then compare a digest computed over the same canonical vocabulary. Match resumes from the persisted frontier; mismatch, unknown algorithm, partial snapshot, generation/revert edge, or series restart falls back to the current full sync. `computeRawRangeFingerprint` is useful vocabulary but is not by itself a cryptographic full-identity proof and does not persist the bytes the module needs.

## Correctness evidence

- Native output delta reconstruction preserves the acknowledged prefix by reference and appends only the replacement suffix. A fingerprint mismatch is rejected.
- Native attachment and prefix projection differential tests compare complete serialized output against the full paths.
- Boundary token-cache tests cover same-length content mutations.
- The adapter tests cover same-length nested tool-input mutation, arbitrary deep mutations, cache-drop full-send fallback, and native-delta fingerprint fencing.
- The `real_daemon` leg remains skipped because the reported sibling daemon boot/registration regression is external to this change.
