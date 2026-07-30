# GameBuddy Voice Gateway

A standalone, localhost-only, token-authenticated Voice Gateway. It owns PTT
capture state, final ASR text, bounded TTS jobs, one mixer owner, cancellation
epochs, and text-safe failure behaviour. It does **not** import Pi/Magic
Context, contact the Stardew bridge, execute Game Actions, persist raw
microphone audio, or own provider credentials.

## Current implementation

- Protocol v1 local newline-delimited JSON control service, bound to
  `127.0.0.1` only and requiring a 16–256-character opaque token.
- 16 kHz mono signed PCM16 PTT contract; partial text is UI-only and final text
  is the only event eligible for Host delivery.
- Bounded speech queue/audio volume, cancellation epochs, and `STOP_ALL` that
  aborts voice work without waiting on or touching a Game Action.
- Provider-neutral fake ASR/TTS/mixer adapters for deterministic CI.
- `MimoTtsProvider` for the locked `mimo-v2.5-tts` SSE/PCM16 contract. The
  caller owns `MIMO_API_KEY`; it is never read from a repository file or
  logged. A missing key/model/device preserves text interaction.
- `SenseVoiceCliAsrProvider` for the external CPU-only FunASR llama.cpp runtime.
  Before it can run, the operator supplies a JSON asset manifest containing the
  runtime/model/VAD paths, locked runtime revision, and SHA-256 hashes. Gateway
  startup verifies both files and hashes; PCM is converted to a transient WAV
  and removed on success, failure, or cancellation. Model metadata tags are
  stripped and never interpreted as player emotion, identity, or consent.

The SenseVoice runtime, GGUF model, FSMN-VAD asset, license/model card, and
Windows fixture are intentionally **not** bundled or silently downloaded. Set
`GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST` only after separately auditing them. With
no manifest, the Gateway stays in text-safe fake-ASR mode rather than claiming
real local ASR. Set `MIMO_API_KEY` plus `GAMEBUDDY_MIMO_VOICE` only when the
operator explicitly enables the cloud TTS provider.

## Run the protocol skeleton

```powershell
$env:GAMEBUDDY_VOICE_TOKEN = '<16+ opaque local token>'
pnpm --filter @gamebuddy/voice-gateway start
```

Use `pnpm --filter @gamebuddy/voice-gateway test` for the fake-provider and
local-server contract suite.

## Demo Gate Preflight

Before the real Phase 1-4 Farmhand, provider, and device runbooks, run:

```powershell
$env:GAMEBUDDY_STARDEW_GAME_PATH = 'D:\Steam\steamapps\common\Stardew Valley'
$env:GAMEBUDDY_SECOND_STARDEW_GAME_PATH = 'D:\path\to\a\separately-licensed\second\Stardew\client'
$env:MIMO_API_KEY = 'rotated_key_in_process_environment_only'
$env:GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST = 'D:\audited-assets\sensevoice-manifest.json'
pnpm verify-demo-prerequisites
```

The command never reads or prints the MiMo key. It fails closed when the
independent legal Farmhand client, rotated credential, or audited local ASR
assets are missing; it does not run a provider request, start Stardew, or
modify a save.
