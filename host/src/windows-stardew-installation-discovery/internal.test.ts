import assert from "node:assert/strict";
import test from "node:test";
import { StardewDiscoverySession } from "./internal.js";

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
  assert.deepEqual(roots.map((entry) => [...entry]), before);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((candidate) => candidate.source), ["steam-registry", "steam-vdf"]);
});

test("normalization is independent of input order", async () => {
  const firstSession = new StardewDiscoverySession();
  const secondSession = new StardewDiscoverySession();
  const first = (await import("./internal.js")).normalizeBoundCandidates(firstSession, [["steam-vdf", "C:\\B"], ["steam-registry", "C:\\A"]]);
  const second = (await import("./internal.js")).normalizeBoundCandidates(secondSession, [["steam-registry", "C:\\A"], ["steam-vdf", "C:\\B"]]);
  assert.deepEqual(first.map(({ source, displayPath }) => ({ source, displayPath })), second.map(({ source, displayPath }) => ({ source, displayPath })));
});
