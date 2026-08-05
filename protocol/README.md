# Bridge-v1 contract

`bridge-v1.schema.json` is the language-neutral envelope contract for the current
**Stardew** bridge. The canonical wire form is camelCase JSON, UTF-8, and a
maximum of 16 KiB per framed message. `fixtures/bridge-v1/golden-sequence.json`
is the checked-in deterministic replay sequence used by the Host test suite.

The envelope framing is transport-neutral, but v1's `Scope`, `Snapshot`, action
IDs, target fields, and receipt vocabulary are intentionally Stardew-shaped.
They are not a general cross-game wire protocol. The Host's
`GameIntegrationModule` seam allows a future adapter to supply its own catalog,
tools, state projection, receipt validator, and transport without teaching the
Host composition root Stardew behavior; it does **not** make a second game use
this schema by default. Any future shared wire version requires an explicit,
versioned protocol proposal and cross-language conformance corpus.

Integration-specific capabilities and action payload validation remain owned by
each Integration. Every supported GameBuddy adapter must still provide
authoritative live state and receipt-backed execution/evidence, but a future
non-Stardew adapter supplies those through its own schema/transport until two
real adapters justify a separately versioned common envelope. This directory
deliberately does not define pathfinding, animation, or generic game action
taxonomies.
