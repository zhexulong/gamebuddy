# Windows legacy authority seal — feasibility spike (blocked)

This directory is test-only.  It does not participate in the Host's locks, broker,
store, coordinator, routing, or production build assets.

## Result

A reliable same-user seal of an old-process legacy partition root cannot be built
from supported Windows ACL primitives without creating a bypass.  This spike must
**not** be promoted as a production seal.

Windows grants access when a handle is opened; changing a file or directory DACL
does not revoke access already present on a `FileStream`/Win32 handle.  The
independent `legacy-writer-fixture.ps1` opens a read/write handle before the
hypothetical seal and the test proves that it can still write through that handle.
Consequently an ACL sealer cannot meet the required post-seal denial guarantee for
an already-running legacy writer.

Further, the current user normally owns the created root.  The owner has
`WRITE_DAC` authority (and, where needed, can take ownership and rewrite the DACL),
so a deny ACE installed by that same user is not an irrevocable authority boundary.
A process under that user can restore an allow DACL.  Removing the owner/DACL
recovery route requires a distinct privileged authority or an OS boundary, not a
same-user Node/PowerShell process.

Finally, non-privileged same-user code cannot atomically and completely prove that
no process has a writer handle: handle enumeration is privilege-sensitive and any
observation races another process opening or creating a handle.  The test therefore
requires the only honest result: refuse to claim sealing when an independent writer
cannot be disproved.

## What is exercised

`legacy-authority-seal.test.ts` starts the independent PowerShell fixture against an
explicit temporary root. Its authenticated first protocol frame and every subsequent
reply travel over a per-launch, random-named Windows named pipe with a per-launch
nonce; PowerShell stdout/stderr are diagnostics only and never accepted as protocol.
Unexpected pipe frames (including JSON-shaped lookalikes without the protocol and
nonce) fail closed, and any stdout after readiness fails the fixture. It demonstrates
before-seal writes and a pre-existing writer handle that remains writable, verifies
the root still exists and is an exact non-reparse directory, and demonstrates the
required fail-closed refusal condition.
It intentionally does not test a claimed successful seal or assert post-seal denial:
such a claim would be false under the demonstrated handle and owner authority
semantics.

Run on Windows after compilation:

```powershell
npm run build
node --test --test-concurrency=1 dist/windows-legacy-authority-seal/legacy-authority-seal.test.js
```
