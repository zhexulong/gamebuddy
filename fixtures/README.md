# Deterministic fixtures

`bridge-v1/golden-sequence.json` is the versioned, language-neutral protocol
fixture. It provides a fixed scope, ordered authenticated handshake, snapshot,
execution request, and authoritative receipt. Host replay validates every
message against the same envelope/size/scope rules used by transports.

It is not a substitute for native Stardew multiplayer evidence or real SMAPI IPC
smoke tests; those remain separate environment gates.
