# Rust transform r4 native-response roll-forward (2026-08-16)

## Incident evidence

A module bounce did not clear the failure. ENGRAM served a frontier-less full response at
13:29:24, then the immediately following warm request sent a two-message tail delta and failed at
13:29:59 because the adapter received neither native response field. That sequence rules out cold
module state and ordinary LRU eviction as the trigger: the failing request followed a successful
full prime by one pass.

## Source diagnosis

The adapter fingerprint is an ingress identity, not a digest of the transformed output. It combines
the adapter's CK and native ingress fingerprints, sends the value as `full_array_fingerprint`, and
uses the same opaque value as the next `tail_delta.after`. The module does not recompute that value
from pre- or post-reasoning-clear bytes; its transform snapshot, projection cache, and native
attachment cache retain the adapter-supplied string. A pre/post-splice fingerprint-vocabulary change
therefore cannot explain the mismatch at this revision.

The r4 native attachment path did contain a real fingerprint-fence defect. A mismatched attachment
snapshot made `validated_native_prefix` return zero, but the independent encoded-message key scan
could still report a reusable output prefix. The response arm then emitted a native suffix despite
the cache fingerprint mismatch. The regression test reproduces that behavior on the pre-fix code.
The roll-forward now permits a suffix only when cache state, fingerprint, context, and frontier are
all valid. Every other case retains the already-built full native output and logs
`native_delta_fallback_reason=<reason>`.

At source HEAD, native-cache eviction by itself already rebuilt a full attachment when a retained
request could reconstruct ingress, or returned `need_full_sync` before transform when it could not.
Serialized-output cache hits and degraded native stores also did not remove native response fields.
The production observation of an `ok` response with both fields absent was therefore not explained
by the reachable handler branches at HEAD; stale daemon code or an adapter/response-shape skew
remained plausible. A final release-path guard now full-serializes whenever a successful
`serve_native` response reaches the response seam without either native field. The adapter also
retries once with complete arrays if it receives that invalid shape, preventing a warm suffix miss
from becoming a cross-pass outage.

## Memory and latency

The serialized-output, native-attachment, and projection caches remain independent because misses
have different safe recovery paths. Their 256 MiB ceilings now have an explicit 768 MiB aggregate
compile-time bound. Evicting one does not make another authoritative: missing native/projection data
must reconstruct from the ready snapshot or request a full sync.

No retry-until-deadline loop exists in the module's native response arm. The module timing line
separates `request_observed_to_handler`, `delta_expand`, projection lookup/store, `native_attach`,
retained-size/snapshot work, and response encode/splice. The adapter separately reports transport
pages and elapsed transport time. The observed 11.5-second failed pass, together with fresh
connection churn and a 2.5-second successful full pass, is consistent with transport/recovery cost
rather than cache eviction thrash; the incident logs needed to assign that time to a precise module
stage were not retained in this worktree. The one-shot adapter full retry fixes availability but does
not claim that latency as a module-cache optimization.

The concurrent `lkg_anthropic_reasoning_run_invalid` refusal is correct fail-closed behavior:
replaying an LKG with an invalid Anthropic reasoning run could send an illegal signed-thinking
sequence to the provider. It explains why LKG armor could not mask this incident, but should not be
loosened to hide native-response failures.
