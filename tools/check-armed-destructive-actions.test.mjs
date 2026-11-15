/**
 * The falsifier for `tools/check-armed-destructive-actions.mjs`: every verdict seen once, on a real tree.
 *
 * Each case builds a throwaway web workspace - a `tsconfig.json`, a `src/fixture-api.ts` that declares the
 * browser API's shape, and a `src/fixture-consumer.ts` that presses it one way - and drives the gate's own
 * reader over it. A fixture's `dialogue-web/src/...` path is what the gate reports, which is the same
 * spelling the real tree gets, so an exemption written for a fixture is written the way a real one is.
 *
 * The two red cases are the shapes the gate exists for: a press that spends no arm (the voice clear that
 * shipped one press) and a module that never calls the confirmation primitive (a hand-rolled pair with no
 * focus path and no Escape). The rest is the population's own boundary - a non-durable verb is not a press,
 * and the clear that no method name spells IS one - plus both directions of the exemption rule.
 *
 * `armedIn` is resolved against THIS repository (`MessageBubble` arms, so it is the module the arm-owner
 * cases point at; `assert-never` does not).
 *
 * red-proof: inject  a component whose `remove` awaits `api.deleteThing` -> `press_not_armed` and
 *   `confirmation_primitive_absent` naming the fixture's `remove`; the same press with an
 *   arm but no `useArmedConfirmation` -> `confirmation_primitive_absent` alone; `{ clear: true }` as a
 *   request field -> it joins the population (armed, examined 1); `document.removeEventListener`,
 *   `Set.delete` and `clearTimeout` -> examined 0 and `blocked` with exit 1; an exemption pointed at a
 *   module that does not arm -> `exemption_arm_owner_unarmed`, one naming no site -> `exemption_expired`,
 *   one matching two sites -> `exemption_count_mismatch`, a reason or an expiry too short to name anything
 *   -> `exemption_unreasoned` (tools/check-armed-destructive-actions.test.mjs)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkArmedDestructiveActions } from "./check-armed-destructive-actions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = [];

after(() => {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
});

const TS_CONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["ES2022", "DOM"],
  },
  include: ["src"],
});

/** The API the fixture consumer presses: one durable method, one whose destruction travels as a field. */
const API_MODULE = `
export type FixtureApi = Readonly<{
  deleteThing(handle: string, revision: number): Promise<void>;
  updateThing(
    command: Readonly<{ apiVersion: 1; expectedRevision: number }> & (Readonly<{ text: string }> | Readonly<{ clear: true }>),
  ): Promise<void>;
}>;
`;

/** The confirmation primitive and the state it reads, as the real tree spells them (no react needed here). */
const HARNESS = `
export function useArmedConfirmation(armed: boolean, onCancel: () => void): Readonly<{ cancel: () => void }> {
  return { cancel: onCancel };
}

export function pairState<T>(initial: T): readonly [T, (next: T) => void] {
  return [initial, () => {}];
}
`;

/** One web workspace whose `src/fixture-consumer.ts` is the given source. */
function workspace(source, { harness = HARNESS } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "armed-destructive-"));
  workspaces.push(parent);
  const webRoot = join(parent, "dialogue-web");
  mkdirSync(join(webRoot, "src"), { recursive: true });
  writeFileSync(join(webRoot, "tsconfig.json"), TS_CONFIG);
  writeFileSync(join(webRoot, "src", "fixture-api.ts"), API_MODULE);
  writeFileSync(join(webRoot, "src", "harness.ts"), harness);
  writeFileSync(join(webRoot, "src", "fixture-consumer.ts"), source);
  return webRoot;
}

const codes = (verdict) => verdict.findings.map((entry) => entry.code);
const press = "dialogue-web/src/fixture-consumer.ts";

/** The shape that shipped: a durable deletion behind one press, in a component that owns no arm at all. */
const BARE = `
import type { FixtureApi } from "./fixture-api";

export function Panel({ api }: { api: FixtureApi }) {
  const remove = async (handle: string): Promise<void> => {
    await api.deleteThing(handle, 1);
  };
  return { remove };
}
`;

/** The shape the tree uses: the handler spends an arm and the module calls the primitive. */
const ARMED = `
import type { FixtureApi } from "./fixture-api";
import { pairState, useArmedConfirmation } from "./harness";

export function Panel({ api }: { api: FixtureApi }) {
  const [armed, setArmed] = pairState(false);
  useArmedConfirmation(armed, () => setArmed(false));
  const confirm = async (handle: string): Promise<void> => {
    setArmed(false);
    await api.deleteThing(handle, 1);
  };
  return { confirm };
}
`;

const EXEMPTION = Object.freeze({
  file: press,
  symbol: "remove",
  call: "api.deleteThing",
  armedIn: "dialogue-web/src/components/MessageBubble.tsx",
  reason:
    "the row that renders this control owns the pair, and this function is the transport the confirmation " +
    "reaches (stated so the falsifier has a well-formed entry to vary)",
  expires: "expires when the press moves into the component that arms it, or that component stops holding the pair",
});

function read(source, exemptions = [], options = {}) {
  return checkArmedDestructiveActions({ webRoot: workspace(source, options), exemptions });
}

test("a durable deletion behind one press is red, and says which function and which call", () => {
  const verdict = read(BARE);
  assert.equal(verdict.status, "failed");
  assert.equal(verdict.examined, 1);
  assert.equal(verdict.armed, 0);
  assert.deepEqual(codes(verdict).sort(), ["confirmation_primitive_absent", "press_not_armed"]);
  const named = verdict.findings.find((entry) => entry.code === "press_not_armed");
  assert.match(named.detail, /fixture-consumer\.ts:6 symbol=remove calls api\.deleteThing/u);
});

test("a press whose handler spends an arm, in a module that calls the primitive, is green", () => {
  const verdict = read(ARMED);
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.status, "passed");
  assert.equal(verdict.armed, 1);
});

test("a hand-rolled pair with no useArmedConfirmation is red on the primitive alone", () => {
  const verdict = read(`
import type { FixtureApi } from "./fixture-api";
import { pairState } from "./harness";

export function Panel({ api }: { api: FixtureApi }) {
  const [armed, setArmed] = pairState(false);
  const confirm = async (handle: string): Promise<void> => {
    setArmed(false);
    await api.deleteThing(handle, 1);
  };
  return { armed, confirm };
}
`);
  assert.deepEqual(codes(verdict), ["confirmation_primitive_absent"]);
});

test("a destruction that travels as a request field is the population's, not a miss", () => {
  const verdict = read(`
import type { FixtureApi } from "./fixture-api";
import { pairState, useArmedConfirmation } from "./harness";

export function Panel({ api }: { api: FixtureApi }) {
  const [voiceClearArmed, setVoiceClearArmed] = pairState(false);
  useArmedConfirmation(voiceClearArmed, () => setVoiceClearArmed(false));
  const clear = async (): Promise<void> => {
    setVoiceClearArmed(false);
    await api.updateThing({ apiVersion: 1, expectedRevision: 1, clear: true });
  };
  return { clear };
}
`);
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.examined, 1);
  assert.equal(verdict.armed, 1);
});

test("the same verbs on content the player can retype are not the population, and zero is blocked", () => {
  const verdict = read(`
export function Panel(target: Element, seen: Set<string>, draft: { clear(): void }): void {
  target.removeEventListener("click", () => {});
  seen.delete("row");
  draft.clear();
  window.clearTimeout(0);
}
`);
  assert.equal(verdict.status, "blocked");
  assert.equal(verdict.examined, 0);
});

test("an empty src is blocked rather than green", () => {
  const verdict = checkArmedDestructiveActions({
    webRoot: workspace(""),
    exemptions: [],
  });
  assert.equal(verdict.status, "blocked");
  assert.equal(verdict.examined, 0);
});

test("an exemption that names the module still arming is accepted, and counts as exempt", () => {
  const verdict = read(BARE, [EXEMPTION]);
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.exempt, 1);
  assert.equal(verdict.armed, 0);
});

test("an exemption whose arm owner dropped the primitive is red, quoting the owner", () => {
  const verdict = read(BARE, [{ ...EXEMPTION, armedIn: "dialogue-web/src/assert-never.ts" }]);
  assert.deepEqual(codes(verdict), ["exemption_arm_owner_unarmed"]);
  assert.match(verdict.findings[0].detail, /assert-never\.ts does not call `useArmedConfirmation`/u);
});

test("an exemption that matches no observed press is expired", () => {
  const verdict = read(ARMED, [{ ...EXEMPTION, symbol: "nothing" }]);
  assert.ok(codes(verdict).includes("exemption_expired"));
});

test("an exemption matching two presses names none of them", () => {
  const verdict = read(
    `
import type { FixtureApi } from "./fixture-api";

export function Panel({ api }: { api: FixtureApi }) {
  const remove = async (): Promise<void> => {
    await api.deleteThing("a", 1);
    await api.deleteThing("b", 1);
  };
  return { remove };
}
`,
    [EXEMPTION],
  );
  assert.deepEqual(codes(verdict), ["exemption_count_mismatch"]);
});

test("a reason or an expiry too short to name anything is a finding, not an exemption", () => {
  const shortReason = read(BARE, [{ ...EXEMPTION, reason: "ok" }]);
  assert.deepEqual(codes(shortReason), ["exemption_unreasoned"]);
  const shortExpiry = read(BARE, [{ ...EXEMPTION, expires: "later" }]);
  assert.deepEqual(codes(shortExpiry), ["exemption_unreasoned"]);
});

test("the real workspace the gate was written for is green and prints its three counts", () => {
  const verdict = checkArmedDestructiveActions({ webRoot: join(ROOT, "dialogue-web") });
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.status, "passed");
  assert.ok(verdict.examined >= 6, `examined ${verdict.examined}`);
  assert.ok(verdict.armed + verdict.exempt === verdict.examined);
});
