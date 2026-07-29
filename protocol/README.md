# Game-neutral bridge contract

`bridge-v1.schema.json` is the language-neutral envelope contract. The canonical
wire form is camelCase JSON, UTF-8, and a maximum of 16 KiB per framed message.
`fixtures/bridge-v1/golden-sequence.json` is the checked-in deterministic replay
sequence used by the Host test suite. Integration-specific capabilities and action
payload validation remain owned by each Integration; this directory deliberately
does not define pathfinding, animation, or generic game action taxonomies.
