# Voice contract fixtures

`mimo-v2.5-tts-sse-redacted.json` is a deliberately redacted protocol capture
for the locked Xiaomi MiMo `mimo-v2.5-tts` SSE/PCM16 contract. It records only
HTTP/SSE envelope facts, field paths, PCM16 encoding, event ordering, terminal
classification, provider/model identifiers, and the capture timestamp.

It must never contain an API key, authentication header value, complete source
text, base64/PCM audio payload, or a raw provider response. Regenerate it only
with `tools/capture-mimo-contract.ps1` and its mandatory redaction check.
