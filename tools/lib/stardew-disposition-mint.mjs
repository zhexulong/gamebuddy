/**
 * HOW `WorldModel` MINTS AND SPELLS THE DISPOSITION IT PUBLISHES - read from the Mod's own source, so a contract
 * row's `publishes` block is re-checked against the functions that decide it instead of trusted.
 *
 * TWO FORMS, ONE MINT:
 *
 *   - INLINE - `return new ActorDisposition(ActorDispositionKind.Event, null, false, null);`. The branch states the
 *     kind itself, and the transient word (when the disposition has one) is the fourth argument's string literal.
 *   - THROUGH THE FACTORY - `return Transient(ActorTransientKind.Warping);`. The branch names a member of
 *     `ActorTransientKind`; the private factory beside `Classify` mints
 *     `new(ActorDispositionKind.Transient, null, false, KindForWire(kind))`. The WORD (`KindForWire`'s overload over
 *     `ActorTransientKind`) and the SETTLE WINDOW (`SettleWindowMs`) of that transient are then decided by the one
 *     declaration the member sits in, so a word cannot exist without the ending it promises. That is the shape the
 *     `round97` warp freeze needed, and it is why the branches stopped spelling their words inline - see
 *     `ActorTransientKind`'s own docblock.
 *
 * WHY THIS IS A MODULE AND NOT PART OF ONE CALLER. `tools/derive-stardew-actor-admissibility.mjs` DERIVES the
 * contract's `classifyAt`/`publishes` rows from these branches, and
 * `gates/stardew/check-stardew-actor-admissibility.mjs` RE-READS them. Two readers would be two authorities for one
 * fact, and they diverged the moment the branches moved to the factory form: the generator found no branch at all (it
 * threw `FreezePaused is published by no branch of Classify`) while the gate counted three kinds where the classifier
 * returns four, so seven rows of a generated contract pointed at lines that mint nothing.
 */

/** The text between the bracket at `open` and its match, and the index of that match. */
export function balanced(text, open) {
  const opener = text[open];
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === opener) depth += 1;
    else if (text[i] === closer) {
      depth -= 1;
      if (depth === 0) return { text: text.slice(open + 1, i), start: open + 1, end: i };
    }
  }
  throw new Error(`unbalanced ${opener} at ${open}`);
}

/** Split a parameter/argument list on its top-level commas, with each part's offset. */
export function splitTopLevel(text, base) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    // Angle brackets are NOT counted: a comparison inside an argument (`player.freezePause > 0`) would otherwise
    // close a bracket that was never opened and silently merge every later argument.
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push({ text: text.slice(from, i), at: base + from });
      from = i + 1;
    }
  }
  if (text.slice(from).trim() !== "") parts.push({ text: text.slice(from), at: base + from });
  return parts;
}

/** The arms of a `kind switch` expression (`KindForWire`, `HoldReasonCode`), and its `_ =>` last resort. */
export function kindSwitchArms(source, signature) {
  const at = source.indexOf(signature);
  if (at < 0) return { arms: new Map(), fallback: undefined };
  const body = balanced(source, source.indexOf("{", at)).text;
  const arms = new Map();
  for (const match of body.matchAll(/ActorDispositionKind\.([A-Za-z_]\w*)\s*=>\s*"([^"]+)"/gu))
    arms.set(match[1], match[2]);
  return { arms, fallback: /_\s*=>\s*"([^"]+)"/u.exec(body)?.[1] };
}

/**
 * The private factory that mints a transient disposition, with the wire word of every `ActorTransientKind` member:
 *
 *     private static ActorDisposition Transient(ActorTransientKind kind) =>
 *         new(ActorDispositionKind.Transient, null, false, KindForWire(kind));
 *
 * `null` when the source carries no such factory - a classifier whose transient branches spell their words inline
 * then needs nothing resolved through it.
 */
export function transientFactory(source) {
  const declaration =
    /private\s+static\s+ActorDisposition\s+([A-Za-z_]\w*)\s*\(\s*ActorTransientKind\s+[A-Za-z_]\w*\s*\)\s*=>/u.exec(
      source,
    );
  if (declaration === null) return null;
  const name = declaration[1];
  const arrow = declaration.index + declaration[0].length;
  const mint = /ActorDispositionKind\.([A-Za-z_]\w*)/u.exec(source.slice(arrow, source.indexOf(";", arrow)));
  if (mint === null) throw new Error(`${name} mints no ActorDispositionKind`);
  // The factory calls `KindForWire(kind)`, so a source carrying the factory without that overload is not the source
  // this reader understands: stop rather than derive a contract whose transients have no words.
  const overload =
    /static\s+string\s+KindForWire\s*\(\s*ActorTransientKind\s+[A-Za-z_]\w*\s*\)\s*=>\s*kind switch/u.exec(source);
  if (overload === null) throw new Error(`${name} names a transient kind, and no KindForWire overload spells one`);
  const words = new Map();
  for (const arm of balanced(source, source.indexOf("{", overload.index)).text.matchAll(
    /ActorTransientKind\.([A-Za-z_]\w*)\s*=>\s*"([^"]+)"/gu,
  ))
    words.set(arm[1], arm[2]);
  return { name, kind: mint[1], words };
}

/**
 * What the `return` at `at` mints: the PRODUCER a row is re-read through, the `ActorDispositionKind` the disposition
 * carries, and the transient word when the branch has one. `null` when the text at `at` is not a mint this reader
 * knows - a third form is not silently accepted, it is refused by the row that cites it.
 *
 * `unwordedMember` is the `ActorTransientKind` member the branch names when `KindForWire` has no word for it - named
 * rather than dropped, because a member with no word is a transient whose ending nobody can publish.
 */
export function dispositionMint(text, at, factory = null) {
  const INLINE = "return new ActorDisposition(";
  if (text.startsWith(INLINE, at)) {
    const call = balanced(text, at + INLINE.length - 1);
    const args = splitTopLevel(call.text, call.start);
    const kind = /ActorDispositionKind\.([A-Za-z_]\w*)/u.exec(args[0]?.text ?? "")?.[1];
    if (kind === undefined) return null;
    return {
      producer: "Classify",
      kind,
      transientKind: /^\s*"([^"]+)"\s*$/u.exec(args[3]?.text ?? "")?.[1] ?? null,
      unwordedMember: null,
      end: call.end,
    };
  }
  if (factory === null) return null;
  const through = `return ${factory.name}(`;
  if (!text.startsWith(through, at)) return null;
  const call = balanced(text, at + through.length - 1);
  const member = /ActorTransientKind\.([A-Za-z_]\w*)/u.exec(call.text)?.[1];
  if (member === undefined) return null;
  return {
    producer: factory.name,
    kind: factory.kind,
    transientKind: factory.words.get(member) ?? null,
    unwordedMember: factory.words.has(member) ? null : member,
    end: call.end,
  };
}

/** Every `ActorDispositionKind` a mint in this source returns - FACT-3's population, derived, not hand-listed. */
export function mintedKinds(source, factory = transientFactory(source)) {
  const kinds = new Set();
  for (const line of source.split("\n")) {
    const mint = dispositionMint(line.trim(), 0, factory);
    if (mint !== null) kinds.add(mint.kind);
  }
  return [...kinds];
}

/**
 * FACT-3's re-read: every kind the classifier MINTS is either `Idle` (the word for a body that is NOT held) or
 * published by at least one fact, and the `Idle` row carries the code for a body nobody holds.
 *
 * A kind with no fact is a hold the Mod can enter and no row can name - the state an Agent would be told nothing about.
 */
export function namedFindings({ kinds, facts, holdReasons }) {
  const rows = [];
  const published = new Set(facts.map((fact) => fact.publishes.kind));
  for (const kind of kinds)
    if (kind !== "Idle" && !published.has(kind)) rows.push(`${kind} is returned by Classify and published by no fact`);
  const idle = holdReasons.find((entry) => entry.kind === "Idle");
  if (idle === undefined) rows.push("no Idle row: the word for a body that is NOT held is missing");
  else if (idle.reasonCode !== "player_not_actionable")
    rows.push(`Idle carries ${idle.reasonCode}; a body that is not held must not carry a hold code`);
  for (const entry of holdReasons.filter((row) => row.kind !== "Idle" && row.publishedBy.length === 0))
    rows.push(`${entry.kind} is published by no fact, so nothing can name it`);
  return rows;
}

/**
 * FACT-2's re-read, one row per declared fact: is the row's kind / wire spelling / reason code / transient word the
 * one the mint its `classifyAt` names decides, and does the branch condition that chose it still precede it?
 *
 * Three functions decide a row and each is re-read where it lives: `Classify` (through the mint, inline or factory -
 * the KIND and the transient WORD), `KindForWire` (the wire spelling of that kind) and `HoldReasonCode` (the code).
 * The census says how many rows each producer carries, so a reader sees which function owns what instead of taking
 * the contract's word for it.
 */
export function publishFindings({ where, worldModel, facts }) {
  const lines = worldModel.split("\n");
  const factory = transientFactory(worldModel);
  const wire = kindSwitchArms(worldModel, "public static string KindForWire(ActorDispositionKind kind) => kind switch");
  const reason = kindSwitchArms(
    worldModel,
    "public static string HoldReasonCode(ActorDispositionKind kind) => kind switch",
  );
  const rows = [];
  const census = new Map([
    ["Classify", 0],
    ...(factory === null ? [] : [[factory.name, 0]]),
  ]);
  const forms = [
    "`return new ActorDisposition(...)`",
    ...(factory === null ? [] : [`\`return ${factory.name}(ActorTransientKind.X)\``]),
  ].join(" nor ");
  for (const fact of facts) {
    const cited = fact.classifyAt?.line;
    const text = (lines[(cited ?? 0) - 1] ?? "").trim();
    const mint = dispositionMint(text, 0, factory);
    if (mint === null) {
      rows.push(`${fact.fact}: classifyAt ${where}:${cited} mints no disposition - it reads "${text}", not ${forms}`);
      continue;
    }
    census.set(mint.producer, census.get(mint.producer) + 1);
    if (mint.unwordedMember !== null)
      rows.push(
        `${fact.fact}: ${where}:${cited} names ActorTransientKind.${mint.unwordedMember}, which KindForWire has no word for`,
      );
    if (mint.kind !== fact.publishes.kind)
      rows.push(
        `${fact.fact}: ${mint.producer} mints ${mint.kind} at ${where}:${cited}, the contract says ${fact.publishes.kind}`,
      );
    if (wire.arms.get(mint.kind) !== fact.publishes.wire)
      rows.push(
        `${fact.fact}: KindForWire(${mint.kind}) = ${wire.arms.get(mint.kind)}, the contract says ${fact.publishes.wire}`,
      );
    const code = reason.arms.get(mint.kind) ?? reason.fallback;
    if (code !== fact.publishes.reasonCode)
      rows.push(`${fact.fact}: HoldReasonCode(${mint.kind}) = ${code}, the contract says ${fact.publishes.reasonCode}`);
    if (mint.transientKind !== (fact.publishes.transientKind ?? null))
      rows.push(
        `${fact.fact}: ${where}:${cited} publishes ${mint.transientKind ?? "no transient word"}, the contract says ${fact.publishes.transientKind ?? "no transient word"}`,
      );
    if ((fact.classifyAt?.condition ?? "").length > 0) {
      const conditionSeen = lines
        .slice(Math.max(0, cited - 20), cited)
        .some((line) => line.includes(fact.classifyAt.condition.slice(0, 60)));
      if (!conditionSeen)
        rows.push(
          `${fact.fact}: the branch condition "${fact.classifyAt.condition}" no longer precedes ${where}:${cited}`,
        );
    }
  }
  return { rows, census: [...census].map(([producer, count]) => `${producer} ${count}`).join(" · ") };
}
