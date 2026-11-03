import assert from "node:assert/strict";
import test from "node:test";
import { StardewDiscoverySession, installationLocationLabel } from "./internal.js";

test("session enforces replay, foreign session, expiry, and invalid paths", () => {
  let now = 10;
  const session = new StardewDiscoverySession(100, () => now);
  assert.throws(() => session.issue("steam-vdf", "not-windows"));
  const candidate = session.issue("steam-vdf", "C:\\Steam\\steamapps\\common\\Stardew Valley");
  assert.throws(() => session.consume(candidate.candidateId, "foreign"));
  assert.equal(session.consume(candidate.candidateId), "C:\\Steam\\steamapps\\common\\Stardew Valley");
  assert.throws(() => session.consume(candidate.candidateId));
  const expired = session.issue("steam-registry", "C:\\Other");
  now = 111;
  assert.throws(() => session.consume(expired.candidateId));
});

test("normalizes duplicate roots case-insensitively with stable ordering without mutating input", async () => {
  const session = new StardewDiscoverySession();
  const roots: readonly (readonly ["steam-vdf" | "steam-registry", string])[] = [
    ["steam-vdf", "C:\\Z"],
    ["steam-registry", "c:\\a"],
    ["steam-vdf", "C:\\A"],
    ["steam-vdf", "C:\\z"],
  ];
  const before = roots.map((entry) => [...entry]);
  const result = (await import("./internal.js")).normalizeBoundCandidates(session, roots);
  assert.deepEqual(
    roots.map((entry) => [...entry]),
    before,
  );
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((candidate) => candidate.source),
    ["steam-registry", "steam-vdf"],
  );
});

test("normalization is independent of input order", async () => {
  const firstSession = new StardewDiscoverySession();
  const secondSession = new StardewDiscoverySession();
  const first = (await import("./internal.js")).normalizeBoundCandidates(firstSession, [
    ["steam-vdf", "C:\\B"],
    ["steam-registry", "C:\\A"],
  ]);
  const second = (await import("./internal.js")).normalizeBoundCandidates(secondSession, [
    ["steam-registry", "C:\\A"],
    ["steam-vdf", "C:\\B"],
  ]);
  assert.deepEqual(
    first.map(({ source, displayPath }) => ({ source, displayPath })),
    second.map(({ source, displayPath }) => ({ source, displayPath })),
  );
});

/**
 * The label a candidate is told apart by. Two Steam libraries both install to
 * `...\steamapps\common\Stardew Valley`, so `label` and `hint` are identical for both
 * and the panel had nothing to render differently: the fault the OOBE review measured
 * as "two identical rows". The drive and the library's own folder name are the smallest
 * facts that separate them, and neither is a path.
 */
test("a location label names the drive and the library, never the path", () => {
  assert.equal(installationLocationLabel("C:\\Steam\\steamapps\\common\\Stardew Valley"), "C: · Steam");
  assert.equal(installationLocationLabel("D:\\SteamLibrary\\steamapps\\common\\Stardew Valley"), "D: · SteamLibrary");
  // The fact the panel needs: two installations are different when this differs, and
  // identical when it does not.
  assert.notEqual(
    installationLocationLabel("C:\\Steam\\steamapps\\common\\Stardew Valley"),
    installationLocationLabel("D:\\SteamLibrary\\steamapps\\common\\Stardew Valley"),
  );
  assert.equal(
    installationLocationLabel("C:\\Steam\\steamapps\\common\\Stardew Valley"),
    installationLocationLabel("C:\\Steam\\steamapps\\common\\Stardew Valley"),
  );
  // The folder's own spelling is what a player recognises; the label never rewrites it.
  assert.equal(installationLocationLabel("C:\\SteamLibrary\\steamapps\\common\\Stardew Valley"), "C: · SteamLibrary");
  // Nothing past the library root, and no executable name.
  for (const root of [
    "C:\\Steam\\steamapps\\common\\Stardew Valley",
    "D:\\SteamLibrary\\steamapps\\common\\Stardew Valley",
  ]) {
    const label = installationLocationLabel(root);
    assert.ok(label !== null && !label.includes("steamapps") && !label.includes("Stardew Valley.exe"), root);
    assert.ok(label !== null && !label.includes("common"), root);
  }
});

test("a library under a user's own folder is named by its drive alone", () => {
  // `C:\Users\<name>\steamapps` would publish that profile's folder name - an identity
  // leak in a screenshot - so the drive is all the label may say there.
  assert.equal(installationLocationLabel("C:\\Users\\long\\steamapps\\common\\Stardew Valley"), "C:");
});

test("a root the label cannot locate falls back to the drive, never to a path", () => {
  assert.equal(installationLocationLabel("E:\\Games\\Stardew Valley"), "E:");
  assert.equal(installationLocationLabel("not-windows"), null);
});

test("each issued candidate carries the location of the root it was issued for", () => {
  const session = new StardewDiscoverySession();
  const first = session.issue("steam-vdf", "C:\\Steam\\steamapps\\common\\Stardew Valley");
  const second = session.issue("steam-vdf", "D:\\SteamLibrary\\steamapps\\common\\Stardew Valley");
  assert.equal(first.location, "C: · Steam");
  assert.equal(second.location, "D: · SteamLibrary");
  // The redacted display path is untouched: the label is an addition, not a replacement.
  assert.equal(first.displayPath, "Detected installation (path hidden)");
});
