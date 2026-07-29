# Third-party dependency audit

This directory records the reproducible dependency evidence required for GameBuddy releases.

## Node dependency inventory

Generate the lockfile-derived inventory after `pnpm install --frozen-lockfile`:

```powershell
node tools/generate-sbom.mjs
```

It invokes `pnpm licenses list --json` and emits `sbom-node.json` in CycloneDX-shaped JSON. The committed npm `pnpm-lock.yaml` remains the exact package/integrity source; this report preserves package name, resolved version(s), license expression, and upstream homepage for review.

## Direct dependencies

| Component | Locked source/version | License | Product use / removal path |
|---|---|---|---|
| Pi coding-agent SDK | `@earendil-works/pi-coding-agent@0.82.1` | MIT | Restricted Companion session runtime. Remove by replacing `host/src/runtime.ts` session construction. |
| Magic Context | `@cortexkit/pi-magic-context@0.33.0` | MIT | Explicitly loaded extension only; remove by deleting the locked extension path/config in `host/src/runtime.ts`. |
| SMAPI build integration | `Pathoschild.Stardew.ModBuildConfig@4.4.0` | MIT | Build-time SMAPI Mod packaging; no Stardew binaries are distributed. |
| Stardew Valley / SMAPI runtime | locally installed Stardew `1.6.15`, SMAPI `4.5.2` | proprietary game / SMAPI license | Required only for local Mod build and game validation; never copied into this repository. |
| MiMo V2.5 TTS | Xiaomi HTTP/SSE API (`mimo-v2.5-tts`) | service terms | Optional Gateway adapter; disabled without local `MIMO_API_KEY`, removable without Host/Mod interface changes. |
| SenseVoiceSmall / FSMN-VAD | not yet selected or shipped | pending asset audit | The real CPU ASR asset is not a dependency until provenance, license, hash, and Windows benchmark are recorded. |

## Provider and secret boundary

`MIMO_API_KEY` belongs exclusively in the ignored root `.env.local` or an operator environment. It is never committed, logged, placed in a fixture, or emitted by the SBOM. The redacted MiMo fixture records only request/response contract shape and no user text or audio.

## Upgrade policy

Every direct dependency upgrade must update the lockfile/integrity, regenerate `sbom-node.json`, re-run the full Host/Voice/SMAPI regression commands, and document any new model asset, service contract, or license obligation before release.
