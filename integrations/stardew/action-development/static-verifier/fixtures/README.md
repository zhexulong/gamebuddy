# Static verifier fixtures (package-owned producer slice)

This directory is the producer side of the static-verifier producer-consumer-test slice.

- `input.*.v1.json` — package-owned, schema-exact verifier inputs consumed by
  `../verify-static.mjs`. The CLI accepts only relative paths inside this
  directory, and `artifactRoot` is resolved relative to the static-verifier
  directory (never an absolute or escaping path).
- `closure/*` — placeholder artifact roots named by the inputs. The files are
  deterministic placeholders (not compiled assemblies); the Node verifier
  checks existence and basic usability only.
  - `pass/` — complete Mod/Core sibling pair plus contract output: `passed`.
  - `absent/` — no artifacts exist at all: `blocked`.
  - `partial/` — Mod only, no sibling Core: `failed` (partial closure).
  - `malformed/` — Core present, Mod present but empty (0 bytes): `failed`
    (malformed target).
  - `contract-missing/` — complete pair but missing contract output: `failed`
    (build/contract failure).
- `input.malformed-json.v1.json` — duplicate JSON key, rejected at parse time.
- `input.root-scope.v1.json` — non-package-owned scope, rejected at admission.

CLI exit codes: `0` passed, `1` failed, `2` blocked, `3` input rejected.