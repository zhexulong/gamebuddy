/**
 * The three authored-context claims, read in BOTH directions from one run's capture.
 *
 * `observation.cjs`'s census answers "which declared section did this request carry, and how big was it".
 * It cannot answer "is the fact I put in the store the fact the model received": a section can arrive
 * with the right byte count and the wrong content, and a preset's sampling values are not in the
 * messages at all. These three readings close that gap for the three things the player authors - her
 * memory, her world book, her preset - and each one is read TWICE:
 *
 *   carried   a turn taken while the fact WAS bound, where it must arrive
 *   absent    a turn taken while it was NOT bound, where it must not arrive
 *
 * One direction alone proves nothing. A reader that always says "absent" passes the second direction on
 * every run, and a reader that always says "present" passes the first on every run; only a run that
 * produces both, from the same instrument and the same capture, says that authored context reaches the
 * provider. So a claim is `proven` only when the carried reading arrived AND the absent reading did not,
 * and every other outcome has its own name here instead of being reported as a pass.
 *
 * WHAT THIS MODULE DOES NOT DO: it sends no turn and writes no row. A driver (or a test with a capture
 * file) produces the two turns and says which submission key was which state. The separation is
 * deliberate - a reader that also drove the product could manufacture the state it was about to look
 * for, which is the self-certification this repository's rules are written against.
 *
 * The census is `observation.cjs`'s, not a second opinion: section names and byte counts come from
 * `injectionFacts`, whose population is the emitters' own declaration (`injection-declaration.mjs`). The
 * request text comes from the live kit's ONE wire reader (`chat/wire-contract.mjs::wireMessageText`), for
 * the reason that reader exists - a message's content is a string on some turns and `{type,text}` parts
 * on others.
 */
import observation from "./observation.cjs";
import { readInjectionDeclaration } from "./injection-declaration.mjs";
import { wireMessageText } from "../../chat/wire-contract.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const { injectionFacts, readCapturedRequests } = observation;

/** The three claims, in the order a run reads them: what she remembers, what she was told, how she speaks. */
export const INJECTION_CLAIMS = Object.freeze(["memory", "worldBook", "sampling"]);

/** A claim's verdict vocabulary. `proven` is the only member that says the context reached the provider. */
export const CLAIM_VERDICTS = Object.freeze([
  "proven",
  "carried_direction_failed",
  "absent_direction_failed",
  "unobserved",
]);

const unobserved = (reason) => ({ state: `unobserved:${reason}`, detail: null });

/** Every message's text in the request, in order - the same reading `observation.cjs` takes. */
function requestTextOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.map((message) => wireMessageText(message)).join("\n");
}

/**
 * The first captured body per submission key.
 *
 * `injectionFacts` joins a driver's turn to its request by the idempotency key it was submitted under,
 * and takes the FIRST record for that key (Pi's tool-call rounds are continuations of the same authored
 * context). The census it returns carries section sizes but no bodies, and a sampling value is not in
 * the messages at all, so the body is resolved here too - with that same rule, spelled once.
 */
function bodiesBySubmissionKey(captured) {
  const byKey = new Map();
  const requests = Array.isArray(captured?.requests) ? captured.requests : [];
  for (const entry of requests) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.body === null || typeof entry.body !== "object" || Array.isArray(entry.body)) continue;
    const key =
      typeof entry.idempotencyKey === "string" && entry.idempotencyKey.trim().length > 0 ? entry.idempotencyKey : null;
    if (key === null || byKey.has(key)) continue;
    byKey.set(key, entry.body);
  }
  return byKey;
}

/**
 * One section's size in one turn's census, or `null` when the census does not hold that section.
 *
 * `null` and `0` are different readings and stay different: a section the declaration names and the
 * request omits is absent, while a section the request carries empty (`<session-history></session-history>`
 * is the shape the decayed-compartment block takes when nothing has been folded yet) is a carried section
 * with no content. Only the second one says the injection path ran for it.
 */
function sectionBytes(turn, name) {
  const carried = turn?.census?.sections?.find((section) => section.name === name);
  return carried === undefined ? null : carried.bytes;
}

/** A carried block's own text, read back from the wire - the bytes the census counted, as content. */
function sectionText(text, name) {
  const match = new RegExp(`<${name}(?=[\\s>])[^>]*>([\\s\\S]*?)</${name}>`, "u").exec(text);
  return match === null ? "" : match[1];
}

/**
 * The memory claim's readings.
 *
 * `sections` is a list of section names because the product has two memory blocks and they are fed by
 * different producers: `<session-history>` is the decayed compartment directory (the fold's output) and
 * `<project-memory>` is the player's own durable memory rows. Proving a fact arrives in the second one
 * says nothing about the first, and this reading refuses to let one stand in for the other.
 */
function memoryReading(turn, text, sections, fact) {
  let carried = null;
  for (const name of sections) {
    const bytes = sectionBytes(turn, name);
    if (typeof bytes === "number" && bytes > 0) {
      carried = { name, bytes };
      break;
    }
  }
  return {
    section: carried === null ? null : carried.name,
    sectionBytes: carried === null ? 0 : carried.bytes,
    factInBody: text.includes(fact),
    /* Two memory blocks travel beside each other, so a fact in the wrong one is a real defect that
     * "the fact arrived" would hide. */
    factInSection: carried === null ? false : sectionText(text, carried.name).includes(fact),
  };
}

/**
 * The world-book claim's readings.
 *
 * The block's size is reported beside the content because the block is the m[1] carrier: an entry whose
 * text is in the request but outside that block is a quote somewhere else (a tool result, the exported
 * catalogue), not the entry being injected.
 */
function worldBookReading(turn, text, declared, entry) {
  return {
    sectionBytes: sectionBytes(turn, declared.volatileKind),
    inBody: text.includes(entry.text),
    inWorldBookBlock: sectionText(text, declared.volatileTag).includes(entry.text),
  };
}

/**
 * The sampling claim's readings.
 *
 * A preset's sampling values reach the wire as top-level request fields (`tavern/preset-sampling.ts`
 * merges them into the provider entry's `modelOverrides`, and the adapter writes that bag into the HTTP
 * body last), so this reads the body rather than the messages. A key that is present with another
 * layer's value is reported as not carried: the claim is that the PRESET's value is what the model is
 * called with, and a preset saying 0.9 while the wire says 0.7 is the false green the preset surface
 * exists to delete.
 */
function samplingReading(body, entry) {
  const carried = body !== null && typeof body === "object" && Object.hasOwn(body, entry.key);
  const value = carried ? body[entry.key] : null;
  return { key: entry.key, carried, value, matches: carried && value === entry.value };
}

/**
 * A memory reading's outcome, as `carried`, `absent`, or a named disagreement between its two halves.
 *
 * `section_without_the_fact` and `fact_outside_the_section` are the shapes that make "it arrived" and "it
 * did not" both wrong: the section came and lost its content, or the content came from somewhere that is
 * not the memory path. Both are reported as not-carried rather than rounded to either answer.
 */
function memoryOutcome(detail, wanted) {
  const carried = detail.factInBody && detail.factInSection;
  if (wanted === "absent") return carried ? "present" : "absent";
  if (carried) return "carried";
  if (detail.factInBody) return "fact_outside_the_section";
  return detail.sectionBytes > 0 ? "section_without_the_fact" : "absent";
}

/** A world-book reading's outcome: the entry is carried only inside the block that carries entries. */
function worldBookOutcome(detail, wanted) {
  const carried = detail.inBody && detail.inWorldBookBlock;
  if (wanted === "absent") return carried ? "present" : "absent";
  if (carried) return "carried";
  if (detail.inBody) return "fact_outside_the_section";
  return typeof detail.sectionBytes === "number" && detail.sectionBytes > 0 ? "section_without_the_fact" : "absent";
}

/**
 * Both readings of one claim, and the verdict the pair supports.
 *
 * `readingOf` returns `{state, detail}`, or `unobserved:<reason>` when that side of the contrast has no
 * capture at all: an unreadable side is a missing measurement, never a pass.
 */
function claimOf(name, entry, readingOf) {
  const carried = readingOf(entry.turns.carried, "carried");
  const absent = readingOf(entry.turns.absent, "absent");
  const blind = [carried, absent].find((reading) => reading.state.startsWith("unobserved"));
  if (blind !== undefined) return { name, verdict: "unobserved", reason: blind.state, readings: { carried, absent } };
  const verdict =
    carried.state === "carried" && absent.state === "absent"
      ? "proven"
      : carried.state !== "carried"
        ? "carried_direction_failed"
        : "absent_direction_failed";
  return { name, verdict, reason: null, readings: { carried, absent } };
}

/** The declared section population, or a thrown reason the declaration could not be read. */
function declarationSections() {
  const declaration = readInjectionDeclaration();
  if (declaration.ok !== true) throw new Error(declaration.reason);
  return {
    memoryBlocks: declaration.memoryBlocks,
    /* The census names the world-book section by its KIND (lorebook_entry); the tag that carries it
     * is the wrapper element, and content is read out of the wrapper, not out of the kind. */
    volatileKind: declaration.volatile.kind,
    volatileTag: declaration.volatile.tag,
  };
}

/**
 * The three claims, read from one capture.
 *
 * `probe` declares what the run DID, not what it should find:
 *
 *   memory     { fact, sections?, turns: { carried, absent } }
 *   worldBook  { text, turns: { carried, absent } }
 *   sampling   { key, value, turns: { carried, absent } }
 *
 * A claim omitted from `probe` is `unobserved` with the reason `probe_names_no_turn_pair`. A claim whose
 * turn has no record in the capture is `unobserved` with `no_capture_for_turn:<key>` - the capture stops
 * at the requests this run recorded, and a turn that never posted (a refused submission, a driver that
 * died) leaves nothing to read rather than an absence on the wire.
 */
export async function readInjectionClaims({ captured, probe }) {
  if (captured === null || captured === undefined || captured.ok !== true)
    return { ok: false, reason: (captured && captured.reason) || "no_provider_request_capture" };
  if (probe === null || typeof probe !== "object" || Array.isArray(probe))
    return { ok: false, reason: "injection_claim_probe_missing" };
  const declared = declarationSections();
  const memorySections = Array.isArray(probe.memory?.sections) ? probe.memory.sections : declared.memoryBlocks;

  const turnIds = [];
  for (const name of INJECTION_CLAIMS) {
    const turns = probe[name]?.turns;
    if (turns === null || typeof turns !== "object") continue;
    for (const key of [turns.carried, turns.absent])
      if (typeof key === "string" && key.length > 0 && !turnIds.includes(key)) turnIds.push(key);
  }
  if (turnIds.length === 0) return { ok: false, reason: "injection_claim_probe_names_no_turns" };

  const census = await injectionFacts(captured, turnIds);
  const censusByTurn = new Map();
  if (census.ok === true) for (const turn of census.turns) censusByTurn.set(turn.turnId, turn);
  const censusReason = census.ok === true ? null : census.reason;
  const bodies = bodiesBySubmissionKey(captured);

  const claims = [];
  for (const name of INJECTION_CLAIMS) {
    const entry = probe[name];
    if (entry === null || typeof entry !== "object" || entry.turns === null || typeof entry.turns !== "object") {
      claims.push({ name, verdict: "unobserved", reason: "probe_names_no_turn_pair", readings: null });
      continue;
    }
    claims.push(
      claimOf(name, entry, (key, wanted) => {
        const body = bodies.get(key);
        if (body === undefined) return unobserved(censusReason === null ? `no_capture_for_turn:${key}` : censusReason);
        const text = requestTextOf(body);
        const turn = censusByTurn.get(key) ?? null;
        if (name === "memory") {
          const detail = memoryReading(turn, text, memorySections, entry.fact);
          return {
            state: memoryOutcome(detail, wanted),
            detail: { turn: key, factLength: entry.fact.length, ...detail },
          };
        }
        if (name === "worldBook") {
          const detail = worldBookReading(turn, text, declared, entry);
          return {
            state: worldBookOutcome(detail, wanted),
            detail: { turn: key, textLength: entry.text.length, ...detail },
          };
        }
        const detail = samplingReading(body, entry);
        const state =
          wanted === "carried" ? (detail.matches ? "carried" : "absent") : detail.matches ? "present" : "absent";
        return { state, detail: { turn: key, ...detail } };
      }),
    );
  }

  return {
    ok: true,
    source: captured.source,
    claims,
    sections: { memory: memorySections, worldBook: declared.volatileKind },
    /* The census's own refusal, when it had one: the section halves of these readings are then blind and
     * the claim verdicts below are stated against the request text alone. */
    census: censusReason === null ? { ok: true } : { ok: false, reason: censusReason },
  };
}

/** The Host seam that carries a preset's sampler values into the request body. */
const SEAM_NAME = "applyPresetSamplingToProviderEntry";

/**
 * The callers of the Host's preset-sampling seam, in its production sources.
 *
 * The sampling claim has no carried direction in this product: `applyPresetSamplingToProviderEntry`
 * (`host/src/tavern/preset-sampling.ts`) merges a preset's sampler values into the provider entry that
 * the adapter writes into the HTTP body, but nothing binds a preset to a chat's runtime, so no turn
 * carries one. That is a fact about the product rather than about a run, and a reader may only report a
 * named absence while it holds - so the fact is MEASURED here instead of asserted. The day a caller
 * appears this returns it by name and the sampling claim stops being allowed to say `unobserved`.
 *
 * A root that cannot be read is `ok: false`, not zero callers: "not measured" and "nothing calls it" are
 * the two readings this repository keeps telling apart.
 */
export function presetSamplingCallers(root) {
  const callers = [];
  let files = 0;
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      files += 1;
      if (!text.includes(SEAM_NAME)) continue;
      if (entry.name === "preset-sampling.ts") continue;
      callers.push(path.slice(root.length + 1).replace(/\\/gu, "/"));
    }
  };
  walk(root);
  if (files === 0) return { ok: false, reason: `preset_sampling_seam_unmeasured:${root}`, callers, files };
  return { ok: true, reason: null, callers, files };
}

/**
 * The claims, read straight from a run's `wire-requests.jsonl`.
 *
 * `read` is injectable so a test can hand in a source of its own; the default reads the file.
 */
export function readClaimsFromCaptureFile({ captureFile, probe, read }) {
  const captured = read === undefined ? readCapturedRequests(captureFile) : readCapturedRequests(captureFile, read);
  return readInjectionClaims({ captured, probe });
}

/**
 * The claims as `INJECTION` lines, which is `phases/report.mjs`'s existing prefix contract: every driver's
 * `INJECTION ` lines land in that one section, so these readings are reconciled beside the census they
 * qualify rather than in a fourth report of their own.
 *
 * Content is never printed - a fact string, an entry's prose and a turn key are all player-authored bytes.
 * What travels is the reading, the section it lands in, its size, and whether the probe string was found.
 */
export function describeClaims(label, reading) {
  if (reading.ok !== true) return [`INJECTION ${label}: unobserved:${reading.reason}`];
  const lines = [];
  for (const claim of reading.claims) {
    if (claim.verdict === "unobserved") {
      lines.push(`INJECTION ${label} claim=${claim.name}: ${claim.reason}`);
      continue;
    }
    lines.push(
      `INJECTION ${label} claim=${claim.name}: ${claim.verdict} carried=${describeReading(claim.readings.carried)}` +
        ` absent=${describeReading(claim.readings.absent)}`,
    );
    for (const side of ["carried", "absent"]) {
      const detail = claim.readings[side].detail;
      if (detail === null) continue;
      lines.push(`INJECTION ${label} claim=${claim.name} reading=${side}: ${describeDetail(claim.name, detail)}`);
    }
  }
  if (reading.census.ok !== true) lines.push(`INJECTION ${label} claims: census_unobserved:${reading.census.reason}`);
  return lines;
}

function describeReading(reading) {
  const detail = reading.detail ?? {};
  if (reading.state === "unobserved") return "unobserved";
  if (detail.factInBody !== undefined)
    return `${reading.state} section=${detail.section ?? "none"} bytes=${detail.sectionBytes}`;
  if (detail.inBody !== undefined) return `${reading.state} bytes=${detail.sectionBytes ?? "none"}`;
  return `${reading.state} ${detail.key}=${detail.carried ? JSON.stringify(detail.value) : "not-carried"}`;
}

function describeDetail(claim, detail) {
  const turn = `turn=${detail.turn}`;
  if (claim === "memory")
    return `${turn} section=${detail.section ?? "none"} bytes=${detail.sectionBytes} factInBody=${detail.factInBody} factInSection=${detail.factInSection} factBytes=${detail.factLength}`;
  if (claim === "worldBook")
    return `${turn} bytes=${detail.sectionBytes ?? "none"} inBody=${detail.inBody} inWorldBookBlock=${detail.inWorldBookBlock} probeBytes=${detail.textLength}`;
  return `${turn} ${detail.key}=${detail.carried ? JSON.stringify(detail.value) : "not-carried"} matches=${detail.matches}`;
}
