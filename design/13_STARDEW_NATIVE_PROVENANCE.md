# 13 Stardew Native Source / Assembly Provenance

> **Status**: required evidence record; currently **incomplete / not publish evidence**.
>
> **Purpose**: make every claim that refers to a locked Stardew native source tree traceable to a particular licensed game assembly and deterministic decompilation input. This record does not ship, redistribute, or license Stardew binaries/source; it records locally observed metadata and hashes only.

## 1. Rule

A local decompiled tree may guide feasibility and contract research, but it cannot by itself establish target-version behavior for a published Game Action. Before a contract relies on native-source provenance, the record MUST contain:

```text
licensed installation root (local-only path or opaque local label; never committed)
assembly relative path
assembly product version
assembly file version
assembly SHA-256
decompiler name/version and invocation/configuration
extraction UTC timestamp
resulting source-tree file manifest hash
source tree Git/source snapshot revision, if one exists
```

The corresponding live gate must still run against the same target-version game installation. A compile against reference assemblies, a decompiler's inferred code, a remote Git label, or a current registry entry is not runtime evidence.

## 2. Current local audit snapshot

| Field | Recorded value | Confidence / limitation |
|---|---|---|
| Snapshot root | `ref/external/StardewValleyDecompiled/Stardew Valley/` | Local `.gitignore`d research artifact; not shipped or runtime-loaded. |
| Snapshot remote | `https://github.com/Dannode36/StardewValleyDecompiled.git` | Source provenance only; remote/source label is not a licensed local assembly attestation. |
| Snapshot Git revision | `5225ef409e42a6159a82cf81200bf6eb315c9961` | Local repository revision; commit date `2024-10-22T20:50:51+11:00`; not a Stardew 1.6.15 attestation. |
| Tree file count | `917` | Deterministic recursive file count at review time. |
| Tree path-set manifest hash | `311e014a638a7f209a9a5c01aba31bf035cfeb2e87c4234b4a3e8736d038a930` | SHA-256 of sorted relative paths only; detects path-set drift. |
| Tree **content** manifest hash | `8ef8fc0a6eae9ca9064a37538c0bc017b0c8e4341a02441ddca072515d4c636c` | SHA-256 over newline-delimited sorted `relative-path + SHA-256(file bytes)` records for the 917 current source files. It identifies the local audit snapshot content, but cannot attest the original game assembly/version. |
| Licensed assembly path/version/SHA-256 | `Stardew Valley.dll`; file version `1.6.15.24356`; length `6,268,416` bytes; SHA-256 `7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee` | Captured by the read-only direct inspector from a local target installation; the absolute installation path is intentionally not recorded. The hash is local evidence and is not a redistributable game artifact. |
| Content manifest | `Content/ContentHashes.json`; SHA-256 `8143aa3110810e0039282ab8e9989417092388edb84c8c3b6c0b6f23840a4349`; relevant logical asset manifest SHA-256 `243318780a118133e0e883493bbd586dfb8b9c563e1bd3dac1a9e8c1af4450c0` | Captured from the same local installation; relevant assets are summarized without copying game content. |
| Decompiler/version/configuration/extraction UTC | `ilspycmd 9.1.0.7988`; configuration digest `63f257b6fc5a149b0161ed500156cfded448e7069c559e02db94fd6829c4735f` (inspector configuration); source snapshot file count `948`; source content manifest SHA-256 `cc6c0bc1eb1a040a1d85af790652aea0e8320d46c41958af4d40180500b81f4b` | The extraction timestamp is present only in the local redacted inspector report and is intentionally not committed; this row records tool/configuration provenance, not a publish gate. |
| Claimed target mapping | `Stardew Valley 1.6.15 build 24356` | **Assembly and Content attested locally; native behavior still requires live validation.** |

Therefore, this snapshot is usable only as an **unverified audit aid**. It may identify candidate native lifecycles such as `Pan.DoFunction`, `CrabPot` placement/collection, totem warps, or tree/debris behavior; it cannot independently support a version-specific publish claim.

## 3. Capture procedure before a target-version publish claim

On a local machine with a legally installed target game and no secrets in output:

1. Obtain the game root through `GAMEBUDDY_STARDEW_GAME_PATH` or an explicit local parameter. Do not write that absolute path into versioned artifacts.
2. Read the exact assembly file(s) used by the integration, at minimum `Stardew Valley.dll`; record relative path, product version, file version, length and SHA-256.
3. Record the exact decompiler name/version, command/configuration and UTC extraction timestamp used to produce the audit snapshot.
4. Produce a content-addressed source manifest: for every emitted source file, sorted relative path plus SHA-256; hash that manifest. Record the source snapshot revision if the output is stored in Git.
5. Compare the assembly product/file version and hash with the locked support declaration. A mismatch is `native_source_provenance_mismatch` and blocks the related contract/live gate.
6. Re-run the relevant native fixture and formal live gate against that exact installation. Record fixture/template and deployed Mod hashes separately; source provenance never substitutes for live evidence.
7. Preserve only metadata/hashes and any required license notice. Do not commit the game DLL, executable, proprietary game data, user save, config or a local installation path.

## 4. Required future artifact schema

A completed per-target record MUST have this shape (illustrative values only):

```json
{
  "schemaVersion": 1,
  "target": {
    "game": "Stardew Valley",
    "claimedVersion": "1.6.15",
    "claimedBuild": "24356"
  },
  "assembly": {
    "relativePath": "Stardew Valley.dll",
    "productVersion": "...",
    "fileVersion": "...",
    "lengthBytes": 0,
    "sha256": "..."
  },
  "decompilation": {
    "tool": "...",
    "toolVersion": "...",
    "configurationDigest": "...",
    "extractedAtUtc": "...",
    "sourceManifestSha256": "..."
  },
  "auditSnapshot": {
    "repositoryRevision": "...",
    "sourceTreeContentManifestSha256": "..."
  }
}
```

The actual record must be version-controlled only if it contains no local path, game binary, user data or secret. Otherwise retain a redacted committed attestation plus a local secure evidence artifact referenced by opaque run ID.

## 5. Consumers

- [`12_STARDEW_PRIMITIVE_ACTION_BASIS.md`](12_STARDEW_PRIMITIVE_ACTION_BASIS.md) may cite native paths only with the limitation in section 2 until this record is complete.
- [`11_GAMEPLAY_CAPABILITY_COVERAGE.md`](11_GAMEPLAY_CAPABILITY_COVERAGE.md) may not mark a target-version variant `covered` from source provenance; contract/live/publish evidence remain required.
- Fixture readiness, attachment telemetry, receipt, postcondition and policy verification remain separate evidence domains.
