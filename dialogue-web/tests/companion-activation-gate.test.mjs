/**
 * Zero forward path: every reachable companion-activation state offers the player a step.
 *
 * `AGENTS.md`: "Every reachable non-terminal state in a lifecycle or state machine must offer at
 * least one valid forward action." This is that rule for the one state machine this surface
 * added: a roster row can be in five distinguishable states, and a state the player can reach
 * with nothing to press is a dead end - exactly the shape the surface was in before the choice
 * control existed, where an archived companion's row could only be read and the sentence told the
 * player to change something no control could change.
 *
 * The population is DERIVED, twice over, so the gate cannot quietly narrow:
 *
 *  - the phases come from `COMPANION_ACTIVATION_PHASES`, the module's own list, so adding a sixth
 *    phase fails here until somebody states its forward action;
 *  - each phase is reached by driving `deriveCompanionActivationControls` with the inputs
 *    `COMPANION_ACTIVATION_INPUTS` declares, so a phase the derivation can no longer produce is
 *    reported as unreachable rather than passing on a hand-written row.
 *
 * The one allowed `terminal` state is `in_play`: she IS the answer, so the player has nothing to
 * do about her - and the gate keeps that the ONLY such state. Everything else must carry a step
 * the surface really offers, checked against the flags the same derivation returns:
 *
 *  - `choose` means `chooseOffered`, i.e. there is a control to press;
 *  - `stop_game_then_choose` means the control is still there and the row says what blocks it;
 *  - `restart` means the recorded choice is marked and the restart sentence is shown;
 *  - `update_or_reload` means the control is withdrawn - which is only acceptable because the
 *    route is not served at all, so no step could be offered on the row.
 *
 * The mutation half proves the rule bites: a phase whose flags offer nothing and whose
 * `forwardAction` is not `terminal` is reported by name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPANION_ACTIVATION_INPUTS,
  COMPANION_ACTIVATION_PHASES,
  deriveCompanionActivationControls,
} from "../src/companion-activation-controls.ts";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SRC = join(DIALOGUE_WEB, "src");
const PANEL = join(WEB_SRC, "components", "CharactersPanel.tsx");
const MODULE = join(WEB_SRC, "companion-activation-controls.ts");

/**
 * Whether the flags a derivation returned carry the step it names. This is the whole rule, in one
 * function, so the real gate and the mutation below run the same comparison.
 */
export function forwardActionHolds(controls) {
  switch (controls.forwardAction) {
    case "terminal":
      // `terminal` is reserved for the companion who IS the answer.
      return controls.markedInPlay;
    case "choose":
      return controls.chooseOffered;
    case "stop_game_then_choose":
      return controls.chooseOffered && controls.stopGameFirst;
    case "restart":
      return controls.markedChosen && controls.restartRequired;
    case "update_or_reload":
      return !controls.chooseOffered;
    default:
      return false;
  }
}

/** The rule over any population, so a planted state drives the exact comparison the gate runs. */
export function zeroForwardPathFindings(phases, inputs, derive) {
  const findings = [];
  for (const phase of phases) {
    const declared = inputs[phase];
    if (declared === undefined) {
      findings.push(`${phase}: reachable phase with no declared inputs, so nothing can reach it`);
      continue;
    }
    const controls = derive(declared);
    if (controls.phase !== phase) {
      findings.push(
        `${phase}: the derivation answers ${JSON.stringify(controls.phase)} for ${phase}'s own inputs, so the phase is unreachable`,
      );
      continue;
    }
    if (!controls.forwardAction) {
      findings.push(`${phase}: reachable non-terminal phase with no forward action`);
      continue;
    }
    if (!forwardActionHolds(controls)) {
      findings.push(
        `${phase}: names the forward action ${JSON.stringify(controls.forwardAction)} but its flags do not offer it ` +
          `(chooseOffered=${controls.chooseOffered}, stopGameFirst=${controls.stopGameFirst}, ` +
          `markedChosen=${controls.markedChosen}, restartRequired=${controls.restartRequired})`,
      );
    }
  }
  return findings;
}

test("forward-path.1: every reachable companion-activation phase offers the player a step", (t) => {
  const findings = zeroForwardPathFindings(
    COMPANION_ACTIVATION_PHASES,
    COMPANION_ACTIVATION_INPUTS,
    deriveCompanionActivationControls,
  );
  const summary = COMPANION_ACTIVATION_PHASES.map((phase) => {
    const controls = deriveCompanionActivationControls(COMPANION_ACTIVATION_INPUTS[phase]);
    return `${phase}->${controls.forwardAction}`;
  });
  t.diagnostic(`forward-path.1: ${COMPANION_ACTIVATION_PHASES.length} phase(s): ${summary.join(", ")}`);
  assert.deepEqual(findings, [], "a reachable state with nothing to press is a dead end");
});

test("forward-path.2: `in_play` is the ONLY state the player has nothing to do about", (t) => {
  const terminal = COMPANION_ACTIVATION_PHASES.filter(
    (phase) => deriveCompanionActivationControls(COMPANION_ACTIVATION_INPUTS[phase]).forwardAction === "terminal",
  );
  assert.deepEqual(
    terminal,
    ["in_play"],
    "she is already the answer there; any other state with no step is the dead end this gate exists for",
  );
  t.diagnostic(`forward-path.2: terminal=${terminal.join(", ")}`);
});

test("forward-path.3: the companion in play is identifiable, and offers no choice", (t) => {
  const inPlay = deriveCompanionActivationControls(COMPANION_ACTIVATION_INPUTS.in_play);
  assert.equal(inPlay.phase, "in_play");
  // Identifiable: the row is marked in play.
  assert.equal(inPlay.markedInPlay, true, "a player must be able to see who is in play");
  // And no control: the Host refuses her by name (`companion_switch_already_in_play`).
  assert.equal(inPlay.chooseOffered, false);

  // The roster really draws that mark, on a row that really carries the phase: the derivation is
  // only half the fact, so the panel's own markup is read for both.
  const panel = readFileSync(PANEL, "utf8");
  assert.match(panel, /data-companion-phase=\{controls\.phase\}/u, "the row states its phase");
  assert.match(panel, /controls\.markedInPlay/u, "the panel reads the in-play mark from the derivation");
  assert.match(panel, /companion-current-badge/u, "the in-play mark is the roster's own badge");
  assert.match(panel, /controls\.chooseOffered/u, "the panel reads the choice from the derivation");
  assert.match(panel, /\{controls\.stopGameFirst &&/u, "the row says what blocks a choice");
  assert.match(panel, /\{chosenHandle !== null &&/u, "a recorded choice shows its own confirmation");
  t.diagnostic("forward-path.3: the mark and the choice both come from the derivation, not from the row");
});

test("forward-path.4: a build that serves no route withdraws the control rather than failing on press", (t) => {
  const unsupported = deriveCompanionActivationControls(COMPANION_ACTIVATION_INPUTS.unsupported);
  assert.equal(unsupported.phase, "unsupported");
  assert.equal(unsupported.chooseOffered, false, "a control that can only fail is the trap this state prevents");
  assert.equal(unsupported.forwardAction, "update_or_reload");

  // The panel withdraws it globally, from the refusal that says the route is absent - not from a
  // guess about the build.
  const panel = readFileSync(PANEL, "utf8");
  assert.match(
    panel,
    /refusal\.routeAbsent\) setActivationUnsupported\(true\)/u,
    "the route's absence is what withdraws the control, and it comes from the refusal",
  );
  assert.match(
    panel,
    /activationServed: !activationUnsupported/u,
    "every row is told the route is absent, so no row keeps a control that could only fail",
  );
  t.diagnostic("forward-path.4: unsupported comes from the refusal's own code, not from a build guess");
});

test("forward-path.5 (mutation): a phase whose flags offer nothing is reported by name", (t) => {
  // The rule exercised on planted states: one that names a step it does not carry, one that names
  // no step at all, and the real `offer` state as the control.
  const planted = {
    planted_dead_end: { phase: "planted_dead_end", forwardAction: "choose", chooseOffered: false },
    planted_silent: { phase: "planted_silent", forwardAction: null },
  };
  const derive = (input) => planted[input.name];
  const findings = zeroForwardPathFindings(
    ["planted_dead_end", "planted_silent", "offer"],
    {
      planted_dead_end: { name: "planted_dead_end" },
      planted_silent: { name: "planted_silent" },
      offer: { name: "offer" },
    },
    (input) => (input.name === "offer" ? deriveCompanionActivationControls(COMPANION_ACTIVATION_INPUTS.offer) : derive(input)),
  );
  assert.equal(findings.length, 2, `exactly the two planted states must fail, saw ${JSON.stringify(findings)}`);
  assert.match(findings[0], /^planted_dead_end: names the forward action "choose" but its flags do not offer it/u);
  assert.match(findings[1], /^planted_silent: reachable non-terminal phase with no forward action/u);
  // The real state in the same population passes: the comparison is not simply always-red.
  assert.deepEqual(
    findings.filter((finding) => finding.startsWith("offer:")),
    [],
  );
  t.diagnostic(`forward-path.5: planted -> ${findings.join(" | ")}`);
});

test("forward-path.6: the phase list and the derivation are one authority, so neither can drift alone", (t) => {
  const module = readFileSync(MODULE, "utf8");
  // The declared list is the gate's population; the union is the type it must equal. Both are read
  // out of the module - the union by its own declaration block, not by scanning every member-shaped
  // line in the file (the `CompanionForwardAction` union has the same shape and is a different
  // vocabulary) - which is what makes "a sixth phase fails here" true rather than aspirational.
  const declarationStart = module.indexOf("export type CompanionActivationPhase =");
  assert.notEqual(declarationStart, -1, "the phase union is still declared where the gate reads it");
  const declarationEnd = module.indexOf(";", declarationStart);
  assert.notEqual(declarationEnd, -1, "the phase union's declaration is terminated");
  const unionBlock = module.slice(declarationStart, declarationEnd);
  const unionPhases = [...unionBlock.matchAll(/\|\s*"([a-z_]+)"/gu)].map((match) => match[1]);
  assert.equal(
    unionPhases.length,
    COMPANION_ACTIVATION_PHASES.length,
    `the union declares ${unionPhases.length} phase(s) and the list enumerates ${COMPANION_ACTIVATION_PHASES.length}: ` +
      "a phase in one and not the other is a state the gate never looks at",
  );
  assert.deepEqual(
    [...unionPhases].sort(),
    [...COMPANION_ACTIVATION_PHASES].sort(),
    "the union and the enumerated list are the same states",
  );
  for (const phase of COMPANION_ACTIVATION_PHASES) {
    assert.ok(
      COMPANION_ACTIVATION_INPUTS[phase] !== undefined,
      `${phase} has declared inputs, so the gate can reach it`,
    );
  }
  // Nothing in the gate declares its own list: the population, the inputs and the derivation are
  // imported, so there is no second list to forget to update when a phase is added.
  const gateSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(
    gateSource,
    /import \{[^}]*COMPANION_ACTIVATION_PHASES[^}]*\} from "\.\.\/src\/companion-activation-controls\.ts"/u,
    "the phase list is imported from the module that owns it",
  );
  assert.doesNotMatch(
    gateSource,
    /^const (COMPANION_)?PHASES\b/mu,
    "the gate declares no phase list of its own, which is how a gate stops seeing a phase that was added",
  );
  t.diagnostic(`forward-path.6: ${COMPANION_ACTIVATION_PHASES.length} phase(s) declared, enumerated and reachable`);
});
