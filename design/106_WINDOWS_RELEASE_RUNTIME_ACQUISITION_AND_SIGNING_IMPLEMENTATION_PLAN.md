# Windows Release Runtime Acquisition and Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a Windows release CI pipeline that obtains one pinned Node runtime by SHA-256, safely packages it into a verified Host generation, then signs and verifies the final installer without granting runtime provenance authority to the player, Desktop, or ordinary development builds.

**Architecture:** A protected Windows release workflow owns network acquisition and final distribution signing. It downloads one committed Node v24.20.0 Windows x64 ZIP, verifies its committed SHA-256, safely extracts a fixed archive tree, and supplies a one-shot module-private verified-runtime capability to the existing Host publisher. The Host publisher remains the sole generation inventory/runtime-admission authority; a separate distribution stage signs the completed installer last and verifies its signature before release upload.

**Tech Stack:** GitHub Actions Windows runner; Node.js 24.13.0 contributor toolchain; packaged Node.js v24.20.0 Windows x64 runtime; Node `crypto`; a release-only safe ZIP extractor; existing Host production-artifact publisher; Windows Authenticode signing provider.

**Spec:** `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md`; `design/tasks/active/host-bundled-runtime-bootstrap-contract.md`; `design/tasks/active/windows-desktop-host-runtime-admission.md`; `host/production-artifact.config.json`.

## Global Constraints

- Production runtime identity is exactly Node.js `v24.20.0`, Windows x64, from `https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip`, with SHA-256 `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`.
- Node Release Team PGP verification is explicitly replaced by the fixed ZIP SHA-256 release-CI contract; remove PGP keyring/OpenPGP as production runtime provenance authority.
- Runtime download occurs only in a protected Windows release CI job. Player startup, ordinary development/PR CI, and Host publisher public APIs never download a runtime or accept a runtime URL/path/checksum override.
- Production publisher accepts only a module-private, one-shot verified runtime capability. It must not accept `process.execPath`, PATH, system Node, an arbitrary filesystem path, ordinary JSON claims, or a test fixture.
- ZIP extraction uses a fresh CI-private directory, rejects traversal/rooted/duplicate/reparse/link/special entries, admits only the fixed `node-v24.20.0-win-x64/` root, and creates a lexicographically sorted complete regular-file closure before publisher handoff.
- Host generation inventory and `host-runtime-admission/v1` remain the sole Host artifact/runtime provenance authority. The installer signature does not replace those checks.
- Sign embedded PE payloads before their bytes enter the publisher inventory. Assemble the installer from an exact allowlist, sign the final Setup executable last, verify Authenticode/timestamp after signing, and reject any post-sign modification.
- Development and test paths remain fail-closed when release capability is unavailable. Test fixtures stay test-only and never form release evidence or production output.
- No installer technology, signing provider, certificate secret name, or release artifact upload is implemented until the repository has an approved installer builder and protected signing provider contract. This is an explicit downstream dependency, not a fallback opportunity.

---

## File Structure

| File | Responsibility |
|---|---|
| `design/tasks/active/host-bundled-runtime-bootstrap-contract.md` | Current task authority: replace PGP prerequisite with release-CI hash acquisition and add the release acquisition ownership boundary. |
| `host/production-artifact.config.json` | Keep the fixed Node URL/hash/runtime closure contract; remove signer/keyring metadata. |
| `host/scripts/production-artifact.mjs` | Keep publisher generation authority; provide private one-shot release acquisition-to-publish composition without a public path or verification-claim API. |
| `host/scripts/node-runtime-release-acquisition.mjs` | New release-only fixed-input downloader, digest verifier, ZIP admission/extraction, full closure construction, and one-shot publisher handoff. |
| `host/scripts/node-runtime-release-acquisition.test.mjs` | Synthetic-byte tests for downloader admission, ZIP safety, closure construction, capability forgery/replay, cleanup, and no ambient source fallback. |
| `host/scripts/production-artifact.test.mjs` | Publisher integration tests consuming only the sealed release-acquisition test capability; retain fixture/provenance rejection tests. |
| `host/scripts/build-production-artifact.mjs` | Remain fail-closed for normal builds; expose no release path injection. |
| `host/scripts/build-release-production-artifact.mjs` | New release-only entry that calls the internal acquisition/publish composition using fixed module-relative config/trust. |
| `host/scripts/build-production-artifact.test.mjs` | Preserve fail-closed tests and browser-composition tests conditioned on approved release capability. |
| `host/package.json`, `pnpm-lock.yaml`, `third_party/sbom-node.json` | Remove `openpgp` if no other Host consumer remains; add only the reviewed ZIP extraction dependency if Node built-ins cannot meet the Windows safety contract; update inventory. |
| `.github/workflows/ci.yml` | Split ordinary host-quality checks from a protected Windows release job; release job only gets network acquisition and signing permissions/secrets. |
| installer-builder paths (new, after owner selection) | Consume a verified generation, exact-allowlist payload, sign outer installer, verify final signature, write redacted release evidence. |

## Dependency Graph

```text
Task 1 contract cleanup
  → Task 2 safe release acquisition + capability
    → Task 3 release-only Host publication
      → Task 4 protected CI workflow
        → Task 5 installer builder/signing (blocked: installer/signing owner contract)
```

### Task 1: Replace the runtime provenance contract with release-CI fixed-hash acquisition

**Files:**
- Modify: `design/tasks/active/host-bundled-runtime-bootstrap-contract.md`
- Modify: `host/production-artifact.config.json`
- Modify: `host/scripts/node-runtime-acquisition.test.mjs`
- Delete: `host/publisher-trust/node-release-signer-v24.20.0.asc`
- Delete: `host/publisher-trust/node-release-signer-v24.20.0.json`
- Delete: PGP-only acquisition fixtures under `host/scripts/test-fixtures/node-runtime-acquisition/`
- Modify: `host/package.json`, `pnpm-lock.yaml`, `third_party/sbom-node.json` only if `openpgp` becomes unused

**Consumes:** User-approved release CI fixed-SHA contract.

**Produces:** One current-owner source of truth that identifies the fixed ZIP and SHA-256, and no PGP/keyring production authority.

- [ ] **Step 1: Write contract-failure tests before deleting PGP authority**

  Add tests asserting `bundledRuntime` has only the exact fixed archive/runtime fields and that config parsing rejects `requiredSignerFingerprint`, key-file metadata, `pgpVerified`, and URL/hash overrides.

  ```js
  await assert.rejects(
    readArtifactConfigFromText({ ...config, bundledRuntime: { ...config.bundledRuntime, requiredSignerFingerprint: "x" } }),
    /invalid_production_artifact_config/,
  );
  ```

- [ ] **Step 2: Run the focused contract test red**

  Run: `node --test host/scripts/node-runtime-acquisition.test.mjs`

  Expected: failing PGP-specific assumptions demonstrate the prior contract is still active.

- [ ] **Step 3: Rewrite the active task and config as hash-only release-CI authority**

  Replace the PGP/keyring wording with: release CI downloads the exact committed URL and checks the committed SHA-256 before safe extraction; it cannot accept caller overrides or perform player/development download. Remove signer/key metadata from config and production code.

- [ ] **Step 4: Remove obsolete PGP-only code, fixtures, dependency and SBOM references**

  Delete only code/fixtures with no remaining consumer. If `openpgp` has no workspace consumer, remove it through `pnpm`, regenerate the lockfile/SBOM using repository commands, and prove no production runtime closure imports it.

- [ ] **Step 5: Run contract checks**

  Run: `node --test host/scripts/node-runtime-acquisition.test.mjs`

  Run: `pnpm --filter @gamebuddy/companion-host typecheck`

  Expected: hash-only contract tests pass; no PGP/keyring production source remains.

### Task 2: Implement safe release-only runtime acquisition and sealed handoff

**Files:**
- Create: `host/scripts/node-runtime-release-acquisition.mjs`
- Create: `host/scripts/node-runtime-release-acquisition.test.mjs`
- Modify: `host/scripts/production-artifact.mjs`
- Modify: `host/scripts/production-artifact.test.mjs`
- Modify: `host/production-artifact.config.json` only to declare bounded archive size/closure limits if they are immutable policy facts

**Consumes:** Task 1 fixed hash-only config.

**Produces:** A module-private `withVerifiedReleaseBundledRuntime(callback)` flow that creates a single-use opaque input from fixed download bytes and a private extraction root; public publisher APIs remain path-free.

- [ ] **Step 1: Write synthetic ZIP admission tests**

  Add synthetic archive fixtures covering traversal, rooted/drive/UNC names, backslash traversal, NUL, duplicate/case-fold duplicate paths, sibling root, rootless file, symlink/reparse/special entry, archive count/expanded-size limits, missing `node.exe`, and cleanup failure.

  ```js
  await assert.rejects(
    acquireForTest({ zipBytes: zipWith(["../outside.txt"]), expectedSha256: digest(zipBytes) }),
    /runtime_zip_entry_forbidden/,
  );
  ```

- [ ] **Step 2: Run ZIP tests red**

  Run: `node --test host/scripts/node-runtime-release-acquisition.test.mjs`

  Expected: failure because no fixed-input acquisition/extraction implementation exists.

- [ ] **Step 3: Implement fixed-only download and digest verification**

  The production entry reads URL/hash only from parsed module-relative artifact config, writes response bytes only under a fresh CI-private temp root, enforces redirect/origin/size policy, hashes the entire body, and rejects any mismatch before extraction. It does not read an environment override or caller path.

  ```js
  async function downloadPinnedArchive(descriptor, acquisitionRoot) {
    const response = await fetch(descriptor.sourceUrl, { redirect: "error" });
    if (!response.ok) throw new Error("pinned_runtime_download_failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== descriptor.archiveSha256) throw new Error("pinned_runtime_digest_mismatch");
    return bytes;
  }
  ```

- [ ] **Step 4: Implement pre-scan, extraction, and complete closure evidence**

  Admit all ZIP entries before writing files. Normalize names, require exactly the declared archive root, reject link/reparse-like attributes and any non-regular payload, ensure case-insensitive uniqueness, then extract to a new directory and verify every resulting path is a regular non-reparse file. Emit sorted `{ sourcePath, sha256 }` records and require declared `node.exe` digest.

- [ ] **Step 5: Mint and consume the capability without public path ingress**

  Keep weak branding/module-private data in `production-artifact.mjs`; the release acquisition module invokes a non-exported or narrowly internal callback supplied at module composition time. A token is consumed exactly once by the publisher; forged, serialized, test-only, replayed, or descriptor-mismatched input fails before staging.

- [ ] **Step 6: Run focused acquisition/publisher checks**

  Run: `node --test host/scripts/node-runtime-release-acquisition.test.mjs`

  Run: `node --test --test-name-pattern="sealed runtime|runtime admission|ambient runtime" host/scripts/production-artifact.test.mjs`

  Expected: synthetic safety matrix and sealed handoff pass; normal publisher remains fail-closed without release acquisition.

### Task 3: Add release-only Host production publication entry

**Files:**
- Create: `host/scripts/build-release-production-artifact.mjs`
- Create: `host/scripts/build-release-production-artifact.test.mjs`
- Modify: `host/scripts/production-artifact.mjs`
- Modify: `host/package.json`
- Modify: `host/scripts/build-production-artifact.mjs`
- Modify: `host/scripts/build-production-artifact.test.mjs`

**Consumes:** Task 2 sealed acquisition callback and existing Host build/publisher closure checks.

**Produces:** A release-only CLI with no runtime source arguments that assembles one verified generation after acquisition; ordinary `buildProductionArtifact()` stays fail-closed.

- [ ] **Step 1: Write red release-entry tests**

  Test that normal `buildProductionArtifact()` still returns `verified_bundled_runtime_input_required`, while a test-controlled fixed release acquisition succeeds and returns a complete generation with fixed runtime/sidecar values.

  ```js
  await assert.rejects(buildProductionArtifact({ outputRoot }), /verified_bundled_runtime_input_required/);
  const published = await buildReleaseProductionArtifactForTest({ outputRoot, fetchPinnedArchive });
  assert.equal(await readBundledNodeVersion(published.artifactRoot), "v24.20.0");
  ```

- [ ] **Step 2: Run release-entry tests red**

  Run: `node --test host/scripts/build-release-production-artifact.test.mjs`

  Expected: no release-only composition entry exists.

- [ ] **Step 3: Implement the no-argument release entry**

  `build-release-production-artifact.mjs` derives host root and release output only from its fixed repository/release layout. It acquires the pinned runtime and invokes existing compilation/browser/native checks plus publisher inside the verified-runtime callback. It accepts no `--runtime-path`, `--url`, `--checksum`, or `--output-root` override.

- [ ] **Step 4: Preserve ordinary build behavior and recover composition coverage**

  `build-production-artifact.mjs` remains the ordinary fail-closed entry. Ensure browser-composition tests use the release-only test seam for their success/mutation path and clearly test ordinary pre-acquisition failure separately; do not conditional-skip regression coverage merely because a sealed test acquisition can make it reachable.

- [ ] **Step 5: Run release publication verification**

  Run: `node --test host/scripts/build-release-production-artifact.test.mjs`

  Run: `node --test host/scripts/build-production-artifact.test.mjs`

  Run: `node --test host/scripts/production-artifact.test.mjs`

  Run: `node --test host/src/desktop-runtime-bootstrap.internal.test.ts`

  Expected: release entry publishes exactly one verifiable generation; normal entry fails closed; browser and publisher regressions run rather than skip under the sealed release test seam.

### Task 4: Separate contributor quality CI from protected Windows release publication

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify/Create: repository release workflow file only after checking current GitHub workflow naming conventions
- Modify: root `package.json` and `host/package.json` scripts only for explicit release commands
- Test: workflow syntax/static assertions in a new `tools/*release*workflow*.test.mjs`

**Consumes:** Task 3 release-only no-argument entry.

**Produces:** Ordinary quality jobs that never attempt runtime download or release publication, plus a protected tag-only Windows job that does acquisition then publishes a verified Host artifact. Signing references only a protected, owner-approved step.

- [ ] **Step 1: Write workflow-shape tests**

  Assert PR/main `host-quality` has no URL download/signing secret/release command and that release workflow triggers only on a protected version tag/manual protected environment; assert release job calls the no-argument release build after quality gates.

- [ ] **Step 2: Run workflow tests red**

  Run: `node --test tools/*release*workflow*.test.mjs`

  Expected: existing `ci.yml` has one mixed host job and no protected release lane.

- [ ] **Step 3: Split CI jobs and add protected release job**

  Rename/adjust ordinary Host job so it runs format/lint/import/type/unit/fail-closed checks but not `pnpm build` or artifact-dependent player tests requiring a generation. Add a release workflow constrained to version tags and protected environment. It invokes only fixed scripts, uses job-private temp roots, and uploads only allowlisted Host generation evidence/artifacts.

- [ ] **Step 4: Add CI behavior tests**

  Prove ordinary job source never calls a runtime downloader or signing command. Prove release job has `contents: read`, minimal artifact permissions, protected environment, no PR trigger, and a cleanup `always()` step that removes the acquisition root.

- [ ] **Step 5: Run CI static checks**

  Run: `node --test tools/*release*workflow*.test.mjs`

  Run: `pnpm format:check`

  Expected: contributor and release responsibilities are mechanically separated.

### Task 5: Installer assembly and Authenticode signing — blocked pending installer/signer owner contract

**Files:**
- Create: installer builder and tests only after the current owner selects the installer technology and signing provider.
- Modify: protected release workflow after Task 4.

**Consumes:** Task 4 verified Host generation and a future explicit installer/signer contract.

**Produces:** Signed final Setup executable and redacted release evidence.

**Blocker:** The repository has no installer builder (WiX/NSIS/custom setup), code-signing certificate/provider, timestamp service, protected environment name, or signed payload file map. Adding any of those from assumption would create a new release authority. This task must remain blocked until those choices are approved.

- [ ] **Step 1: Obtain the installer/signer contract**

  The current owner must select all of: installer technology/version; exact payload layout; embedded executables signed before inventory; signer provider; protected GitHub environment; credential delivery; timestamp endpoint/policy; certificate subject/thumbprint expectation; `signtool` version/policy; and allowed release outputs.

- [ ] **Step 2: Write signing tests against the approved contract**

  Tests must verify exact installer allowlist, rejection of unsigned/tampered bytes, sign-then-verify ordering, timestamp/chain policy, secret-free logs/evidence, and cleanup/quarantine failure.

- [ ] **Step 3: Implement installer assembly from verified generation only**

  The builder takes only the Task 4 verified generation result and fixed product metadata. It rejects checkout binaries, ZIP/ASC/trust files, test artifacts, credentials, user data, and unlisted payloads.

- [ ] **Step 4: Implement protected final signing and post-sign verification**

  Sign embedded PE payloads before inventory, create final Setup, sign Setup last, run `signtool verify /pa /all`, confirm timestamp and expected signer policy, compute final hash, and upload only final installer, hash/manifest, and redacted evidence.

- [ ] **Step 5: Run Windows clean-install release gate**

  Use a fresh VM/profile to install only the signed Setup artifact and demonstrate native Desktop admits the immutable generation/runtime rather than a system Node. This gate depends on `TASK-WINDOWS-DESKTOP-HOST-RUNTIME-ADMISSION` and must not be claimed by this task alone.

## Self-Review

- Spec coverage: Tasks 1–4 cover the user-selected release-CI hash acquisition, source-bound one-shot handoff, safe extraction, Host publication, and contributor/release separation. Task 5 isolates the installer/signing work whose current implementation and credentials do not exist.
- Explicit gap: final installer assembly/signing cannot be implemented safely without a selected installer technology and signing-provider contract; it is called out as a named blocker rather than silently invented.
- Placeholder scan: all code-producing tasks name files, inputs, output contracts, checks, and failure behavior. The one blocked downstream task specifies the exact approval needed before its implementation begins.
- Type consistency: `withVerifiedReleaseBundledRuntime(callback)` / release capability is intentionally module-private; the public entry is the no-argument `buildReleaseProductionArtifact` release composition. Ordinary `buildProductionArtifact()` retains the fixed `verified_bundled_runtime_input_required` failure.

## Execution Handoff

Plan complete and saved to `design/106_WINDOWS_RELEASE_RUNTIME_ACQUISITION_AND_SIGNING_IMPLEMENTATION_PLAN.md`. Execute Tasks 1–4 now via fresh subagent-driven-development waves; Task 5 remains blocked until an installer/signing owner contract exists.
