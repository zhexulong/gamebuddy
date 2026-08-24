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
  logged. A missing key/model/device preserves text interaction. Startup sends
  one bounded non-player probe and requires its first PCM frame to complete a
  real Windows output write before the Gateway reports speech ready.
- `windows-waveout.ps1` plus `WindowsAudioMixer` implement the narrow Windows
  output adapter. Set `GAMEBUDDY_WINDOWS_OUTPUT_DEVICE=default` to select the
  current Windows default multimedia output at each open, or explicitly select
  an enumerated `waveout:N` endpoint. Explicit selection never silently falls
  back to another device. A failed open/write/completion revokes readiness for
  the process; Host then refuses speech presentation.
- `windows-wavein.ps1` plus `WindowsPttCapture` implement a PTT-only Windows
  input adapter. Set `GAMEBUDDY_WINDOWS_INPUT_DEVICE=default` for the current
  Windows default capture device, or an explicit `wavein:N` endpoint. The
  driver must open/start and return bounded 16 kHz mono PCM at an input probe
  before PTT is enabled. The Gateway pulls raw PCM locally only at PTT stop;
  Host never sends or receives PCM. Capture remains disabled unless the
  SenseVoice asset manifest has passed its independent hash audit.
- `SenseVoiceCliAsrProvider` for the external CPU-only Fun-ASR native GGUF
  runtime. Before it can run, the operator supplies a JSON asset manifest for
  the native executable, audio encoder, llama.cpp decoder, and FSMN-VAD, with a
  locked runtime revision and SHA-256 hashes for all three GGUF assets. Gateway
  startup verifies paths and hashes; PCM is converted to a transient WAV and
  removed on success, failure, or cancellation. Bounded PTT runs are decoded as
  fixed sequential chunks; the audited VAD asset is retained for a separately
  reviewed long-audio mode, and does not silently discard early PTT speech.
  Model metadata tags are stripped and never interpreted as player emotion,
  identity, or consent. User PTT validation must not reveal, hash, compare,
  score, or persist a transcript outside the user's own local product UI.

The Fun-ASR native runtime, SenseVoice encoder GGUF, decoder GGUF, FSMN-VAD
asset, license/model card, and Windows fixture are intentionally **not**
bundled or silently downloaded. Set `GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST` only
after separately auditing all of them. With
no manifest, the Gateway stays in text-safe fake-ASR mode rather than claiming
real local ASR. Set `MIMO_API_KEY` plus `GAMEBUDDY_MIMO_VOICE` only when the
operator explicitly enables the cloud TTS provider.

## Run the protocol skeleton

```powershell
$env:GAMEBUDDY_VOICE_TOKEN = '<16+ opaque local token>'
# Current Windows default output. Or list and choose a stable endpoint:
# powershell -ExecutionPolicy Bypass -File voice-gateway/windows-waveout.ps1 -Mode list
$env:GAMEBUDDY_WINDOWS_OUTPUT_DEVICE = 'default'
$env:GAMEBUDDY_MIMO_VOICE = 'Chloe'
# Requires GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST to have passed hash audit:
$env:GAMEBUDDY_WINDOWS_INPUT_DEVICE = 'default'
pnpm --filter @gamebuddy/voice-gateway start
```

Use `pnpm --filter @gamebuddy/voice-gateway test` for the fake-provider and
local-server contract suite. The startup log says `listening`, not `ready`:
protocol `ready` is false without a provider probe and real mixer. Gateway
close performs `STOP_ALL`, destroys authenticated sockets, and then closes the
listener so a persistent Host socket cannot block shutdown. `waveOut` is an
output-only adapter: microphone capture remains unavailable until separately
configured audited SenseVoice assets complete their own PTT open/read/ASR gate.

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
