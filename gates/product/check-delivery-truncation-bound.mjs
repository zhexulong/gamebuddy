#!/usr/bin/env node
/**
 * The gate for "the delivery bounds her speech at a number its own layer invented" - `maxChars: 80` is the instance, the
 * class is that nothing read where a delivered line's ceiling came from.
 *
 * <p>
 * WHY (measured 2026-11-16, `round62`: 90 turns carried text, 70 delivered a bubble). The Host cut every turn's speech at
 * 80 characters - 77 with the reaction sound - and **18 turns lost their tails: 533 characters, 26 whole sentences**,
 * deleted before the player saw them. The 80 described neither surface it claimed to. The presentation transport carries
 * 4,000 characters (`integrations/stardew/BridgeSession.cs` `MaximumPresentationTextLength`, refused as
 * `companion_presentation_text_too_long`), the bubble draws two lines of 448 px - about 34 CJK glyphs - and clamps itself
 * with a visible `…` (`CompanionBubble.cs`), and the chat line beside it keeps the whole text for scroll-back, which is
 * what `ModEntry.cs` calls "the authority for the receipt". So a "compliant" 79-character line already ended in `…` on
 * screen: the number was the transport's bound divided by fifty, and the only thing it ever shortened was the record that
 * survives.
 * </p>
 *
 * <p>
 * THE POPULATION IS DERIVED, never listed. Three kinds of site, each found by reading the tree:
 * </p>
 *
 * <ul>
 *   <li>A BOUND DECLARATION: every `lengthBudget: Object.freeze({ maxChars: ... })` in `host/src` (tests excluded). The
 *     delivery is allowed exactly one, and its number is the thing this gate judges. A second budget anywhere is a
 *     finding too - two bounds that agree today are a disagreement scheduled for later.</li>
 *   <li>A STRAY CHARACTER BOUND: every other `maxChars:` value site in `host/src`. A type declaration
 *     (`maxChars: number`) is a shape and is counted aside; a value site is a second ceiling nobody asked for.</li>
 *   <li>The TRANSPORT'S OWN THREE DECLARATIONS, read from the producers by name: the Mod's constant, the wire schema's
 *     `maxLength`, and the Host's one copy.</li>
 * </ul>
 *
 * <p>
 * THE PROPERTY. A delivered line's ceiling is the transport's own, or a budget whose number RESOLVES to the transport's
 * declaration - never a literal at the delivery's layer. So a bound is one of:
 * </p>
 *
 * <ul>
 *   <li>`transport` - the value is the transport's declaration (or the site IS one of the three);</li>
 *   <li>`declared` - the value is a named constant that itself resolves to the transport's declaration within the tree,
 *     which is what a budget derived from a measured surface looks like when the derivation is written down;</li>
 *   <li>`hand-picked` - a numeric literal, or a name that resolves to nothing transport-derived. THIS is the finding:
 *     `delivery_bound_is_hand_picked:<site>:<value>`, naming the bound as it is written (`maxChars: 80`).</li>
 * </ul>
 *
 * <p>
 * The three transport declarations must AGREE (`transport_declarations_disagree`, blocked - a gate that cannot tell which
 * number is the wire's cannot judge a bound against it), the Host's copy must be READ by both consumers
 * (`transport_constant_not_read:<consumer>`, or the copy is prose), and the bubble's own clamp must still be the Mod's
 * (`bubble_clamp_missing:<declaration>`: `ClampToLines`, the `…` it appends, and its own `MaxTextLength`). The clamp is
 * the surface doing its job on text it received complete - it is not a loss, and this gate will not let a Host budget
 * grow back by first deleting the thing that made one unnecessary.
 * </p>
 *
 * <p>
 * ZERO IS NOT A PASS. A tree where the delivery declares no bound at all is `blocked` with
 * `delivery_declares_no_bound`: deleting the budget changes what the player experiences at the wire's ceiling (the whole
 * turn is refused instead of its tail being cut), and that decision belongs in a review, not in a silently smaller
 * population.
 * </p>
 *
 * Usage:
 *   node tools/check-delivery-truncation-bound.mjs                 # the gate; exit 1 on a violation, 2 when blocked
 *   node tools/check-delivery-truncation-bound.mjs --json          # the census, machine-readable
 *   node tools/check-delivery-truncation-bound.mjs --root <dir>    # the gate's own fixture (a copied tree)
 *
 * red-proof: `tools/check-delivery-truncation-bound.test.mjs` injects `maxChars: 80` and reads
 *            `delivery_bound_is_hand_picked` naming it; it also injects a second budget, a Mod/schema disagreement, a
 *            bound that resolves through a local constant (which must pass), and a bubble with its clamp removed.
 */

export const gateDeclaration = {
  id: "check-delivery-truncation-bound",
  domain: "product",
  tier: "l1",
  kind: "contract",
};

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rootFromArgv, withoutComments } from "../../tools/lib/gate-preamble.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/** The Host's source tree: the population of bound declarations is every non-test file under it. */
export const HOST_SOURCE = "host/src";

/**
 * The transport's own declarations, one per producer, each read BY NAME.
 *
 * The Host's copy exists so that this repository has one place a Host number lives; the Mod's and the schema's exist
 * because the wire is theirs. All three must agree or the gate is blocked - the two copies of a boundary value are
 * checked against the producer rather than against each other's memory of it.
 */
export const TRANSPORT_DECLARATIONS = Object.freeze([
  Object.freeze({
    producer: "mod",
    path: "integrations/stardew/BridgeSession.cs",
    read: (source) => {
      const match = /MaximumPresentationTextLength\s*=\s*([\d_]+)\s*;/u.exec(source);
      return match === null ? null : Number(match[1].replaceAll("_", ""));
    },
  }),
  Object.freeze({
    producer: "schema",
    path: "protocol/bridge-v1.schema.json",
    read: (source) => {
      const parsed = JSON.parse(source);
      const value = parsed?.$defs?.companionPresentationRequest?.properties?.text?.maxLength;
      return typeof value === "number" ? value : null;
    },
  }),
  Object.freeze({
    producer: "host",
    path: "host/src/companion-presentation-transport.ts",
    read: (source) => {
      const match = /MAX_COMPANION_PRESENTATION_TEXT_CHARS\s*=\s*([\d_]+)\s*;/u.exec(withoutComments(source));
      return match === null ? null : Number(match[1].replaceAll("_", ""));
    },
  }),
]);

/** The Host's own declaration of the transport's ceiling: anything a bound resolves through is derived from this name. */
export const TRANSPORT_CONSTANT = "MAX_COMPANION_PRESENTATION_TEXT_CHARS";

/**
 * The bubble's clamp, as the Mod declares it. This is the surface drawing the head of a line it received COMPLETE and
 * marking the rest with `…` - so the gate holds it present rather than treating the `…` as a loss.
 */
export const BUBBLE_CLAMP = Object.freeze({
  path: "integrations/stardew/CompanionBubble.cs",
  declarations: Object.freeze(["ClampToLines", 'Ellipsis = "…"', "MaxTextLength"]),
});

/** The two consumers of the Host's copy: the envelope validator and the delivery's own budget. */
export const TRANSPORT_READERS = Object.freeze([
  Object.freeze({ consumer: "protocol_validator", path: "host/src/protocol.ts" }),
  Object.freeze({ consumer: "game_delivery_budget", path: "host/src/companion-delivery-pacing.ts" }),
]);

/** Every finding this gate can go red on: `code` is the id, `protects` the property it is the finding for. */
export const BOUND_RULES = Object.freeze({
  handPicked: {
    code: "delivery_bound_is_hand_picked",
    protects: "a delivered line's ceiling is the transport's own, never a literal chosen at the delivery's layer",
  },
  secondBudget: {
    code: "delivery_declares_second_budget",
    protects: "the delivery declares exactly one length budget, so two bounds cannot drift apart",
  },
  stray: {
    code: "stray_character_bound",
    protects: "no file bounds delivered text outside the one budget the transport feeds",
  },
  disagree: {
    code: "transport_declarations_disagree",
    protects: "the Mod, the wire schema and the Host state the same transport ceiling",
  },
  unread: {
    code: "transport_constant_not_read",
    protects: "the Host's copy of the transport ceiling is what its consumers read, not a number restated beside it",
  },
  clampMissing: {
    code: "bubble_clamp_missing",
    protects: "the bubble still clamps and marks its own overflow, so the delivery has no reason to cut below the wire",
  },
  noBound: {
    code: "delivery_declares_no_bound",
    protects: "the delivery's ceiling is a decision a reader can see, not a population that quietly emptied",
  },
});

/** A budget declaration's own shape: the policy object literal every surface states its ceiling in. */
const BUDGET_SITE = /lengthBudget:\s*Object\.freeze\(\{\s*maxChars:\s*([^\n}]+?)\s*\}\)/gu;

/** Any other `maxChars:` value site, so a second ceiling anywhere in the Host is a site this gate examines. */
const BOUND_VALUE_SITE = /\bmaxChars:\s*([^\n,}]+)/gu;

/** A type declaration of the field, not a value: counted aside rather than judged. */
const TYPE_DECLARATION = /^(?:number|integer)$/u;

/** Every non-test TypeScript file under `directory`, as repository-relative paths. */
function hostSourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-support.ts"))
        continue;
      found.push(relative(root, absolute).replaceAll("\\", "/"));
    }
  };
  const start = join(root, HOST_SOURCE);
  if (!existsSync(start) || !statSync(start).isDirectory()) return found;
  walk(start);
  return found.sort();
}

/**
 * How a bound's value resolves: `transport` when it names the transport's declaration, `declared` when it names a
 * constant that itself resolves to it, `hand-picked` when nothing on the way names it at all.
 *
 * The lookup reads `const NAME = <value>` out of the tree, so an indirection is followed rather than assumed - a bound
 * that hides 80 behind a local constant is still a literal when the constant is read.
 */
function classifyValue(value, sources) {
  const expression = value.trim();
  // The transport's own declaration, read directly: the one shape that IS the wire's number.
  if (expression === TRANSPORT_CONSTANT) return Object.freeze({ kind: "transport", by: expression });
  const names = [...expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)].map((match) => match[1]);
  let seen = 0;
  let pending = [...names];
  const chain = [];
  let literal = /\d/u.test(expression);
  while (pending.length > 0 && seen < 32) {
    const name = pending.shift();
    seen += 1;
    if (name === TRANSPORT_CONSTANT) {
      chain.push(name);
      return literal
        ? Object.freeze({ kind: "hand-picked", by: chain.join(" -> ") })
        : chain.length === 1
          ? Object.freeze({ kind: "transport", by: name })
          : Object.freeze({ kind: "declared", by: chain.join(" -> ") });
    }
    for (const source of sources) {
      const declared = new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+)`, "u").exec(source);
      if (declared === null) continue;
      chain.push(`${name} = ${declared[1].trim()}`);
      if (/\d/u.test(declared[1])) literal = true;
      pending = [...pending, ...[...declared[1].matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)].map((match) => match[1])];
      break;
    }
  }
  const by = chain.length > 0 ? chain.join(" -> ") : expression;
  return Object.freeze({ kind: literal || /\d/u.test(expression) ? "hand-picked" : "declared", by });
}

/** Every site this gate examines, in the order it reports them. */
function census(root) {
  const files = hostSourceFiles(root);
  const sources = files.map((file) => withoutComments(readFileSync(join(root, file), "utf8")));
  const budgets = [];
  const stray = [];
  let shapes = 0;
  for (const [index, file] of files.entries()) {
    const source = sources[index];
    const budgetValues = new Set();
    for (const match of source.matchAll(BUDGET_SITE)) {
      budgetValues.add(match.index);
      budgets.push(
        Object.freeze({
          site: `${file}:${lineOf(source, match.index)}`,
          written: `maxChars: ${match[1].trim()}`,
          ...classifyValue(match[1], sources),
        }),
      );
    }
    for (const match of source.matchAll(BOUND_VALUE_SITE)) {
      const value = match[1].trim();
      if (TYPE_DECLARATION.test(value)) {
        shapes += 1;
        continue;
      }
      // The policy's own declaration is the budget site above; a read of it (`lengthBudget.maxChars`) is not a site.
      if (value.includes(".")) continue;
      let inside = false;
      for (const at of budgetValues) {
        const window = source.slice(at, at + 120);
        if (window.includes(`maxChars: ${value}`)) inside = true;
      }
      if (inside) continue;
      stray.push(
        Object.freeze({
          site: `${file}:${lineOf(source, match.index)}`,
          written: `maxChars: ${value}`,
          ...classifyValue(value, sources),
        }),
      );
    }
  }
  return Object.freeze({ files: files.length, budgets: Object.freeze(budgets), stray: Object.freeze(stray), shapes });
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * Whether a file READS the transport's declaration: the name appears outside every `import` statement, so a module that
 * imports it and then states its own number is the second spelling this gate exists for.
 */
function readsTransportConstant(source) {
  const body = source
    .split("\n")
    .filter((line) => !/^\s*import\b/u.test(line) && !/^\s*\}\s*from\s+/u.test(line))
    .join("\n");
  return body.includes(TRANSPORT_CONSTANT);
}

/** The three transport declarations, and whether they agree. */
function transport(root) {
  const readings = [];
  for (const declaration of TRANSPORT_DECLARATIONS) {
    const absolute = join(root, declaration.path);
    if (!existsSync(absolute))
      readings.push(Object.freeze({ producer: declaration.producer, path: declaration.path, value: null }));
    else
      readings.push(
        Object.freeze({
          producer: declaration.producer,
          path: declaration.path,
          value: declaration.read(readFileSync(absolute, "utf8")),
        }),
      );
  }
  const values = [...new Set(readings.map((reading) => reading.value))];
  return Object.freeze({
    readings: Object.freeze(readings),
    agrees: values.length === 1 && values[0] !== null,
    value: values.length === 1 ? values[0] : null,
  });
}

/** The bubble's clamp declarations, each one the Mod must still carry. */
function bubbleClamp(root) {
  const absolute = join(root, BUBBLE_CLAMP.path);
  if (!existsSync(absolute))
    return Object.freeze({ present: false, missing: Object.freeze([...BUBBLE_CLAMP.declarations]) });
  const source = readFileSync(absolute, "utf8");
  const missing = BUBBLE_CLAMP.declarations.filter((declaration) => !source.includes(declaration));
  return Object.freeze({ present: missing.length === 0, missing: Object.freeze(missing) });
}

/**
 * The gate's one reading: every site, every classification, and the findings they produce.
 *
 * Nothing here decides from prose: the transport's number comes from the three producers, the budget's number from the
 * delivery's own declaration, and every verdict is a comparison between them.
 */
export function readDeliveryBounds(root = REPOSITORY_ROOT) {
  const sites = census(root);
  const wire = transport(root);
  const clamp = bubbleClamp(root);
  const violations = [];

  if (!wire.agrees)
    violations.push(
      Object.freeze({
        code: BOUND_RULES.disagree.code,
        detail: wire.readings.map((reading) => `${reading.producer}=${String(reading.value)}`).join(" · "),
      }),
    );

  if (sites.budgets.length === 0)
    violations.push(
      Object.freeze({
        code: BOUND_RULES.noBound.code,
        detail: `${HOST_SOURCE} declares no lengthBudget/maxChars at all, so no bound was examined`,
      }),
    );
  if (sites.budgets.length > 1)
    violations.push(
      Object.freeze({
        code: BOUND_RULES.secondBudget.code,
        detail: sites.budgets.map((budget) => budget.site).join(", "),
      }),
    );

  for (const bound of [...sites.budgets, ...sites.stray]) {
    if (bound.kind === "hand-picked")
      violations.push(Object.freeze({ code: BOUND_RULES.handPicked.code, detail: `${bound.site} · ${bound.written}` }));
  }
  for (const site of sites.stray)
    violations.push(Object.freeze({ code: BOUND_RULES.stray.code, detail: `${site.site} · ${site.written}` }));

  for (const reader of TRANSPORT_READERS) {
    const absolute = join(root, reader.path);
    const source = existsSync(absolute) ? withoutComments(readFileSync(absolute, "utf8")) : "";
    if (!readsTransportConstant(source))
      violations.push(Object.freeze({ code: BOUND_RULES.unread.code, detail: `${reader.consumer} · ${reader.path}` }));
  }

  for (const declaration of clamp.missing)
    violations.push(
      Object.freeze({ code: BOUND_RULES.clampMissing.code, detail: `${BUBBLE_CLAMP.path} · ${declaration}` }),
    );

  const counted = [...sites.budgets, ...sites.stray];
  return Object.freeze({
    examined: counted.length,
    transport: counted.filter((bound) => bound.kind === "transport").length,
    declared: counted.filter((bound) => bound.kind === "declared").length,
    handPicked: counted.filter((bound) => bound.kind === "hand-picked").length,
    shapes: sites.shapes,
    files: sites.files,
    bounds: Object.freeze(counted),
    wire,
    clamp,
    violations: Object.freeze(violations),
    status: violations.length === 0 ? "passed" : "failed",
  });
}

/** What the default run prints: the census, the wire's number, and every finding by name. */
export function describeDeliveryBounds(reading) {
  const wire = reading.wire.readings
    .map((entry) => `${entry.producer} ${entry.value === null ? "unreadable" : String(entry.value)}`)
    .join(" · ");
  const census = `bounds examined ${String(reading.examined)} · transport-derived ${String(reading.transport)} · declared ${String(reading.declared)} · hand-picked ${String(reading.handPicked)}`;
  const detail = reading.bounds.map((bound) => `  ${bound.kind} ${bound.site} · ${bound.written}`).join("\n");
  const findings =
    reading.violations.length === 0
      ? "no finding"
      : reading.violations.map((violation) => `${violation.code}:${violation.detail}`).join("\n");
  return `${census} · type declarations ${String(reading.shapes)} · files read ${String(reading.files)} · transport ${wire} · bubble clamp ${reading.clamp.present ? "present" : "missing"} · ${reading.status}\n${detail}\n${findings}`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = rootFromArgv(process.argv, REPOSITORY_ROOT);
  const reading = readDeliveryBounds(root);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
  else process.stdout.write(`${describeDeliveryBounds(reading)}\n`);
  if (reading.violations.some((violation) => violation.code === BOUND_RULES.disagree.code)) process.exit(2);
  process.exit(reading.status === "passed" ? 0 : 1);
}
