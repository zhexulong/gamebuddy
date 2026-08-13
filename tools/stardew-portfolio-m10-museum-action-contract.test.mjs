import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkMuseumActionContract,
  validateMuseumActionContract,
  validateMuseumFixtureContract,
} from "./stardew-portfolio-m10-museum-action-contract.mjs";

const CONTRACT = new URL("./stardew-portfolio-m10-museum-action-contract.json", import.meta.url);
const FIXTURE = new URL("../fixtures/stardew/portfolio-m10-museum-contract.json", import.meta.url);
async function load(url) { return JSON.parse(await readFile(url, "utf8")); }
function mutate(source, fn) { return load(source).then((value) => { fn(value); return value; }); }

test("M10 action and fixture contracts are independently unprovisioned and truthful", async () => {
  const contract = await load(CONTRACT);
  const fixture = await load(FIXTURE);
  assert.doesNotThrow(() => validateMuseumActionContract(contract));
  assert.doesNotThrow(() => validateMuseumFixtureContract(fixture));
  assert.deepEqual(await checkMuseumActionContract(CONTRACT), {
    state: "implementation_needed",
    fixtureState: "fixture_needed",
    contractKind: "static_action_contract_only",
    liveClosure: "none",
    publication: "none",
    actions: ["donate_museum_item", "claim_museum_reward"],
    fixture: { fixtureId: "portfolio_m10_museum_nonterminal_v1", state: "fixture_needed", provisioningState: "unprovisioned", liveClosure: "none" },
    sourceAudit: { auditId: "portfolio_m10_museum_source_audit_v1", anchorCount: 8, projectionState: "blocked", liveState: "not_performed" },
    fixtureContract: "fixtures/stardew/portfolio-m10-museum-contract.json",
  });
});

test("M10 contract keeps donation repetition and reward claim as distinct state domains", async () => {
  const contract = await load(CONTRACT);
  assert.deepEqual(contract.actions.map(({ actionId }) => actionId), ["donate_museum_item", "claim_museum_reward"]);
  assert.equal(contract.actions[0].repeatedSemantics.mode, "repeat_single_piece_donation");
  assert.equal(contract.actions[0].commit.inventoryEffect, "one_item_consumed");
  assert.equal(contract.actions[0].commit.collectionEffect, "one_piece_added");
  assert.equal(contract.actions[0].commit.rewardEffect, "none");
  assert.equal(contract.actions[1].commit.collectionEffect, "unchanged");
  assert.equal(contract.actions[1].commit.rewardEffect, "one_reward_claimed");
  assert.equal(contract.actions[1].commit.separateFromDonation, true);
});

test("fresh opaque finite-domain and exact-field boundaries fail closed", async () => {
  const invalidPiece = await mutate(CONTRACT, (value) => { value.pieceDomain.values = ["(O)80"]; });
  assert.throws(() => validateMuseumActionContract(invalidPiece), /values must stay empty/);
  const fakeTarget = await mutate(CONTRACT, (value) => { value.actions[0].target.piece.value = "(O)80"; });
  assert.throws(() => validateMuseumActionContract(fakeTarget), /unmaterialized fresh opaque/);
  const extra = await mutate(CONTRACT, (value) => { value.actions[1].unexpected = true; });
  assert.throws(() => validateMuseumActionContract(extra), /unknown field/);
});

test("inventory, collection, reward and forbidden fallback distinctions cannot be weakened", async () => {
  const inventory = await mutate(CONTRACT, (value) => { value.actions[0].freshPostcondition.inventoryDelta = "unchanged"; });
  assert.throws(() => validateMuseumActionContract(inventory), /postcondition must prove inventory/);
  const reward = await mutate(CONTRACT, (value) => { value.actions[1].commit.collectionEffect = "one_piece_added"; });
  assert.throws(() => validateMuseumActionContract(reward), /separate from donation/);
  const ui = await mutate(CONTRACT, (value) => { value.forbiddenBehavior.pop(); });
  assert.throws(() => validateMuseumActionContract(ui), /approved bounded policy/);
});

test("fixture rejects provisioning, terminal facts, and result artifacts", async () => {
  const provisioned = await mutate(FIXTURE, (value) => { value.status.provisioningState = "provisioned"; });
  assert.throws(() => validateMuseumFixtureContract(provisioned), /unprovisioned/);
  const terminal = await mutate(FIXTURE, (value) => { value.startingState.terminalFacts = "reward_eligible"; });
  assert.throws(() => validateMuseumFixtureContract(terminal), /terminal/);
  const result = await mutate(FIXTURE, (value) => { value.receipt = "succeeded"; });
  assert.throws(() => validateMuseumFixtureContract(result), /unknown field/);
});

test("CLI contract path is explicit and malformed/missing contract fails closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "m10-museum-contract-"));
  try {
    const malformed = path.join(directory, "malformed.json");
    await writeFile(malformed, "{not-json", "utf8");
    await assert.rejects(() => checkMuseumActionContract(malformed), /Unable to read or parse M10 action contract/);
    await assert.rejects(() => checkMuseumActionContract(path.join(directory, "missing.json")), /Unable to read or parse M10 action contract/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
