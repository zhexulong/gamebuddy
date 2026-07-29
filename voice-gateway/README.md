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

The default real CPU ASR asset/runtime (SenseVoiceSmall GGUF plus FSMN-VAD) is
not yet installed or licensed in this repository. Its adapter and target-Windows
fixture gate remain explicit Phase 3/4 work; no fake ASR is represented as the
real provider.

## Run the protocol skeleton

```powershell
$env:GAMEBUDDY_VOICE_TOKEN = '<16+ opaque local token>'
pnpm --filter @gamebuddy/voice-gateway start
```

Use `pnpm --filter @gamebuddy/voice-gateway test` for the fake-provider and
local-server contract suite.
