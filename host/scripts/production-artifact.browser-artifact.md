# Browser artifact publisher interface

The builder may place browser files in its private emitted closure only at:

```text
browser/tavern/v1/index.html
browser/tavern/v1/tavern-browser-artifact-manifest.json
browser/tavern/v1/assets/<manifest-listed hashed asset>
```

`publishProductionArtifact()` reads the fixed `browserArtifact` descriptor from
`production-artifact.config.json`; it accepts no builder-provided source,
destination, identity, entry-root, or dynamic-import configuration. It rejects
every `browser/` path outside `browser/tavern/v1/`, and accepts files in that
subtree only when they exactly match the fixed manifest identity
`{ browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1" }`.

The exact builder call interface is:

```js
await publishProductionArtifact({
  hostRoot,
  emittedRoot: closureRoot,
  outputRoot,
});
```

Immediately before publication the publisher compares the descriptor's final
verified browser-tree snapshot (paths, modes, and SHA-256 digests) with the
snapshot checked before inventory creation. Any mismatch fails publication; it
does not accept a newly rehashed replacement snapshot. This is a pathname-based
TOCTOU reduction, not a substitute for an OS handle-based atomic verifier.

The builder must verify its private staging output with Host
`verifyTavernStaticArtifact()` before copying that exact tree into the emitted
closure. No browser runtime, HTTP server, or dialogue-web import is involved in
this publisher boundary.

Node `lstat()` symbolic-link checks remain defense in depth only. They do not
prove exclusion of arbitrary Windows reparse points. Artifact construction
therefore verifies only the fixed Windows reparse helper binary and canonical
manifest when that helper is configured; it never reads or accepts a stored
probe-evidence JSON. A release prerequisite must invoke its repository-owned
Windows live gate afresh. Any optional redacted gate audit record is passive
output and cannot authorize artifact publication or verification.
