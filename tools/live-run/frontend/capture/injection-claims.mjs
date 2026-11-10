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
export const INJECTION_CLAIMS = Object.freeze(["memory", "worldBook", "preset"]);

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
 * `sections` is a list of section names because the product emits its memory in more than one block, and the
 * blocks are produced at different moments by different readers:
 *
 *   `<session-history>`   the decayed compartment directory the fold writes. Empty until a fold has run, and
 *                         empty in every run without a model, which is why the declaration renders it empty
 *                         rather than omitting it.
 *   `<project-memory>`    the durable memory rows, read when a session's m[0] baseline MATERIALIZES
 *                         (`inject-compartments-pi.ts:1412`, `getMemoriesByProject(db, memPath, [active,
 *                         permanent])`) and then served from that cache. A row written after the baseline
 *                         exists does not appear here; it arrives in that turn's m[1] delta instead
 *                         (`:2270`, `<new-memories>`), which is a different block and a different reading.
 *
 * So a reading names the block that CARRIES the fact, not the first block that happens to have bytes: a
 * run whose history has been folded carries a non-empty `<session-history>` on every turn, and a reader that
 * stopped at the first block with bytes would report `<project-memory>` as "a section without the fact" on
 * exactly the turns where it carried the fact.
 */
function memoryReading(turn, text, messages, sections, fact) {
  const blocks = [];
  for (const name of sections) {
    const bytes = sectionBytes(turn, name);
    if (typeof bytes === "number") blocks.push({ name, bytes });
  }
  const factSection = blocks.find((candidate) => sectionText(text, candidate.name).includes(fact)) ?? null;
  const carried = factSection ?? blocks.find((candidate) => candidate.bytes > 0) ?? null;
  return {
    section: carried === null ? null : carried.name,
    sectionBytes: carried === null ? 0 : carried.bytes,
    blocks: blocks.map((candidate) => `${candidate.name}:${candidate.bytes}`).join(","),
    factInBody: text.includes(fact),
    /* Two memory blocks travel beside each other, so a fact in the wrong one is a real defect that
     * "the fact arrived" would hide. */
    factInSection: factSection !== null,
    factSection: factSection === null ? null : factSection.name,
    leaks: messageLeaks({
      evidence: [["memory.fact", fact]],
      texts: messages.map((message) => wireMessageText(message)),
      roles: messages.map((message) => (typeof message?.role === "string" ? message.role : "")),
      isCarrier: (_label, _at, one) => sections.some((name) => sectionText(one, name).includes(fact)),
    }),
  };
}

/**
 * The world-book claim's readings.
 *
 * The block's size is reported beside the content because the block is the carrier: an entry whose text is
 * in the request but outside that block is a quote somewhere else (a tool result, the exported catalogue),
 * not the entry being injected.
 *
 * THE FIXTURE'S ENTRIES ARE THE BOOK'S ALWAYS-ON ONES (`constant: true`), so they ride the stable authored
 * block (`<gamebuddy-authored-context>`, the m[0] prefix) and the block this claim names is that one. A
 * KEYWORD-GATED fixture was the earlier shape, and it forced the probe to type its trigger words into the
 * player's own turn - a turn the probe authored, which is the one thing a reader of injection must not count
 * as the product's assembly. `enabled` is still the only variable between the two directions.
 */
function worldBookReading(turn, text, declared, entry, messages, roles) {
  return {
    sectionBytes: sectionBytes(turn, declared.authoredTag),
    inBody: text.includes(entry.text),
    inAuthoredBlock: sectionText(text, declared.authoredTag).includes(entry.text),
    leaks: messageLeaks({
      evidence: [["worldBook.text", entry.text]],
      texts: messages.map((message) => wireMessageText(message)),
      roles,
      isCarrier: (_label, _at, one) => sectionText(one, declared.authoredTag).includes(entry.text),
    }),
  };
}

/**
 * Evidence a probe wrote into the conversation is evidence of the probe, not of injection.
 *
 * A provider body is assembled by the product out of what the player stored; the ONE message a probe
 * authors is its own player turn. So an evidence string that turns up where its own placement rule does not
 * name it - and above all in an `assistant` message, which is model output no probe wrote - is a body
 * carrying bytes that did not arrive by injection. This is the reading a body-wide `includes` hides: the
 * 2026-11-12 run submitted `gbw3enabledkey and gbw3disabledkey are both in this line` as the player's turn,
 * and the trigger words it then "found" had been planted by the probe.
 *
 * `evidence` is `[label, marker]` pairs; `isCarrier(label, index, text)` says whether this message is one
 * the label's own placement rule names. Every finding carries the two facts a failure must state: the marker
 * and the role it was found in.
 */
function messageLeaks({ evidence, texts, roles, isCarrier }) {
  const leaks = [];
  for (const [label, marker] of evidence) {
    if (typeof marker !== "string" || marker.length === 0) continue;
    for (let at = 0; at < texts.length; at += 1) {
      if (!texts[at].includes(marker)) continue;
      const role = roles[at] === "" ? "unlabelled" : roles[at];
      if (role === "assistant") {
        leaks.push({ label, marker, role, at, reason: "in_an_assistant_message" });
        continue;
      }
      if (!isCarrier(label, at, texts[at])) {
        leaks.push({ label, marker, role, at, reason: "outside_the_block_its_placement_names" });
      }
    }
  }
  return leaks;
}

/**
 * The preset claim's readings, in the TWO halves a preset actually has.
 *
 * A preset is `prompt_order` plus sampler values (design `tavern-preset-compatibility` §2.4/§5), and the two
 * halves reach the wire by DIFFERENT paths, so one reading for both would hide which one arrived:
 *
 *   prompts   rendered entries, placed by `preset-request-segments.ts::placeSegments`. `before` joins the
 *             LEADING SYSTEM message's text (not a system message of its own - `pi-ai`'s
 *             `collapseSystemMessages` drops every system message after the first), and `after`/`depth`
 *             become `user` messages after the transcript. So "the string is in the body" is not the claim:
 *             the claim is that it is in the block its own placement rule names. A marker quoted inside the
 *             player's line, a tool result or the world-book block is a body that carries the bytes and not
 *             the injection.
 *   sampling  merged into `models.json` (`withPresetSampling`) and written into the HTTP body as a TOP-LEVEL
 *             field by the adapter, which is why this reads the body rather than the messages. A key present
 *             with another layer's value is reported as not carried: the false green this feature exists to
 *             delete is a panel printing 0.13 while the wire sends 0.7.
 *
 * THE TWO HALVES AND THE ONE MOUNT BOUNDARY. The segments are republished before every prompt
 * (`p4-provider-start-execution.ts:660`), so clearing the binding stops them on the very next request. The
 * sampler is not: it is re-derived from the binding when a Chat runtime is CONSTRUCTED
 * (`runtime-core.internal.ts:1456` reads `boundPresetSampling` for that mount) and written into `models.json`
 * for that runtime to send from then on. So a turn taken in a Chat mounted while the preset is bound carries
 * the sampler, and a turn taken in a Chat mounted after the unbind does not - which is the pair this claim
 * reads, and which the 2026-11-11 run of driver V measured in both directions: three markers in their own
 * placements plus `temperature: 0.13` while bound; no marker and no sampler in the Chat mounted after the
 * unbind. `models.json`'s own last write is 3 ms after that mount's surface session was created, so the
 * write is the mount's construction, not a later rewrite.
 *
 * WHAT THAT LEAVES FRAGILE, named because the reading depends on it: the sampler follows the binding only as
 * of the LAST Chat mount. Clearing the binding while a Chat is already mounted leaves that Chat's request
 * carrying the sampler until another Chat mounts (`applyCompanionModelSelection` rewrites the entry without
 * it too, `runtime-core.internal.ts:2025`). A run that took its absent turn in the already-mounted Chat would
 * therefore read `absent_direction_failed` with `markers=0/3` and the sampler still matching - a shape this
 * reader names rather than rounds.
 */
function presetReading(text, body, entry) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const texts = messages.map((message) => wireMessageText(message));
  const roles = messages.map((message) => (typeof message?.role === "string" ? message.role : ""));
  // Where the player's own line sits, so "after the transcript" is an index comparison rather than a guess.
  const playerLine = typeof entry.playerLine === "string" ? entry.playerLine : "";
  const playerAt = playerLine.length === 0 ? -1 : texts.findIndex((one) => one.includes(playerLine));
  const markerOf = (marker, block) => {
    const at = typeof marker === "string" && marker.length > 0 ? texts.findIndex((one) => one.includes(marker)) : -1;
    const inBody = at >= 0;
    /*
     * `before` must be the FIRST message's text: that is exactly the placement `placeSegments` produces (it
     * joins the leading message, or unshifts one), and it is the placement that survives
     * `collapseSystemMessages`. The role is REPORTED rather than asserted - a transport may call the leading
     * message `system` or `developer`, and pinning the word while position is the real invariant would fail
     * the claim on a transport difference that changes nothing about where the preset went.
     *
     * `after`/`depth` must sit after the player's own line. With no anchor on the wire there is nothing to
     * compare against, so presence is all that can be read and the detail says so.
     */
    const inItsBlock = inBody && (block === "before" ? at === 0 : playerAt >= 0 ? at > playerAt : true);
    return {
      block,
      marker: typeof marker === "string" ? marker : null,
      inBody,
      inItsBlock,
      role: inBody ? roles[at] : null,
      index: inBody ? at : null,
      indexFromEnd: inBody ? texts.length - 1 - at : null,
    };
  };
  const placements = [
    markerOf(entry.markers?.before, "before"),
    markerOf(entry.markers?.after, "after"),
    markerOf(entry.markers?.depth, "depth"),
  ];
  // Only the markers the probe actually planted are scored: an omitted one is not a placement that failed.
  const usable = placements.filter(
    (one) => typeof entry.markers?.[one.block] === "string" && entry.markers[one.block].length > 0,
  );
  const key = typeof entry.sampling?.key === "string" ? entry.sampling.key : null;
  const carried = key !== null && body !== null && typeof body === "object" && Object.hasOwn(body, key);
  const value = carried ? body[key] : null;
  return {
    bodyMessages: texts.length,
    playerAnchored: playerAt >= 0,
    markers: usable,
    markersExpected: usable.length,
    markersInBody: usable.filter((one) => one.inBody).length,
    markersInPlace: usable.filter((one) => one.inItsBlock).length,
    sampler: {
      key,
      carried,
      value,
      /* "carried" and "carried but blank" are different readings of the same key: a body that sends
       * `temperature: null` is a layer that wrote the field and left it empty, not one that sent nothing. */
      empty: carried && (value === null || value === "" || value === undefined),
      matches: carried && value === entry.sampling?.value,
    },
    leaks: messageLeaks({
      evidence: [
        ["preset.before", entry.markers?.before],
        ["preset.after", entry.markers?.after],
        ["preset.depth", entry.markers?.depth],
      ],
      texts,
      roles,
      isCarrier: (label, at) => {
        const block = label.slice("preset.".length);
        return block === "before" ? at === 0 : playerAt >= 0 ? at > playerAt : true;
      },
    }),
    textLength: text.length,
  };
}

/**
 * The preset claim's outcome, as `carried`, `absent`, or the named disagreement between its two halves.
 *
 * `markers_absent` / `markers_out_of_place` / `sampling_not_carried` are the three shapes that make "it
 * arrived" useless: the preset never reached the request, it reached it in the wrong block, or only its
 * sampler did. On the absent side ANY surviving half is `present`, because the claim is that the preset
 * stops reaching the model when it stops being bound.
 */
function presetOutcome(detail, wanted) {
  const promptsCarried = detail.markersExpected > 0 && detail.markersInPlace === detail.markersExpected;
  const samplerCarried = detail.sampler.matches === true;
  if (wanted === "absent") return detail.markersInBody > 0 || samplerCarried ? "present" : "absent";
  if (promptsCarried && samplerCarried) return "carried";
  if (detail.markersInBody === 0) return "markers_absent";
  if (!promptsCarried) return "markers_out_of_place";
  return "sampling_not_carried";
}

/** A preset probe that planted nothing is a missing measurement, not a preset that arrived nowhere. */
function presetProbeIsEmpty(entry) {
  const markers = entry?.markers ?? {};
  const planted = [markers.before, markers.after, markers.depth].filter(
    (marker) => typeof marker === "string" && marker.length > 0,
  );
  return planted.length === 0 && (typeof entry?.sampling?.key !== "string" || entry.sampling.key.length === 0);
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
  const carried = detail.inBody && detail.inAuthoredBlock;
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
    /* The block the book's always-on entries ride, by its own declared tag - the same name the census
     * reports (`gamebuddy-authored-context`), so the claim is asserted against a section name rather than
     * against "somewhere in the body". */
    authoredTag: declaration.authored.tag,
  };
}

/** Every string a claim searches for as its own evidence, labelled, in the order the claims are read. */
function claimEvidence(name, entry) {
  if (name === "memory") return [["memory.fact", entry?.fact]];
  if (name === "worldBook") return [["worldBook.text", entry?.text]];
  return [
    ["preset.before", entry?.markers?.before],
    ["preset.after", entry?.markers?.after],
    ["preset.depth", entry?.markers?.depth],
  ];
}

/**
 * The two things the probe itself must never do, read over every body the capture holds.
 *
 *   1. submit one of its own markers as the turn it types - `text.includes(entry.text)` would then credit the
 *      probe's own sentence as the injection;
 *   2. submit (or print) the diagnostic sentence it used to submit, which is the shape this lane was opened
 *      for: `gbw3enabledkey and gbw3disabledkey are both in this line`.
 *
 * Both findings carry the marker and the role, because "a marker was found" without either is a message the
 * next reader cannot act on. A finding is not a claim failure - the claims can still read `proven` - and that
 * is exactly why it has to be printed: a capture whose instrument wrote its own evidence has measured the
 * probe, not the product.
 */
function instrumentFindings({ captured, probe }) {
  const requests = Array.isArray(captured?.requests) ? captured.requests : [];
  const evidence = INJECTION_CLAIMS.flatMap((name) => claimEvidence(name, probe?.[name]));
  const said = typeof probe?.said === "string" && probe.said.length > 0 ? probe.said : null;
  const diagnostic =
    typeof probe?.diagnosticSentence === "string" && probe.diagnosticSentence.length > 0
      ? probe.diagnosticSentence
      : null;
  const findings = [];
  for (const request of requests) {
    const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
    for (let at = 0; at < messages.length; at += 1) {
      const text = wireMessageText(messages[at]);
      const role = typeof messages[at]?.role === "string" ? messages[at].role : "unlabelled";
      const turn = typeof request?.idempotencyKey === "string" ? request.idempotencyKey : null;
      if (diagnostic !== null && text.includes(diagnostic)) {
        findings.push({
          label: "probe.diagnosticSentence",
          marker: diagnostic,
          role,
          at,
          turn,
          reason: "the_probes_own_diagnostic_sentence",
        });
      }
      if (said === null || !text.includes(said)) continue;
      for (const [label, marker] of evidence) {
        if (typeof marker === "string" && marker.length > 0 && text.includes(marker))
          findings.push({ label, marker, role, at, turn, reason: "the_probe_turn_carries_its_own_evidence" });
      }
    }
  }
  return findings;
}

/**
 * The three claims, read from one capture.
 *
 * `probe` declares what the run DID, not what it should find:
 *
 *   memory     { fact, sections?, turns: { carried, absent } }
 *   worldBook  { text, turns: { carried, absent } }
 *   sampling   { key, value, turns: { carried, absent } }
 *   said       the exact turn text the probe typed, checked for every claim's evidence (see `instrumentFindings`)
 *   diagnosticSentence  the sentence the probe used to submit, asserted absent from every body
 *
 * A claim omitted from `probe` is `unobserved` with the reason `probe_names_no_turn_pair`. A side whose key is
 * absent (`null`, or a turn the driver never sent) is `no_turn_key_for:<side>` - a turn that was never sent and
 * a turn whose request was never recorded are two different silences. A claim whose turn HAS a key but no
 * record in the capture is `no_capture_for_turn:<key>` - the capture stops at the requests this run recorded,
 * and a turn that never posted (a refused submission, a driver that died) leaves nothing to read rather than an
 * absence on the wire.
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
        if (typeof key !== "string" || key.length === 0) return unobserved(`no_turn_key_for:${wanted}`);
        const body = bodies.get(key);
        if (body === undefined) return unobserved(censusReason === null ? `no_capture_for_turn:${key}` : censusReason);
        const text = requestTextOf(body);
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const roles = messages.map((message) => (typeof message?.role === "string" ? message.role : ""));
        const turn = censusByTurn.get(key) ?? null;
        /*
         * A leak overrides the claim's own outcome, and only where that outcome would otherwise be a pass.
         * On the carried side a marker that arrived outside its block is not the injection; on the absent side
         * a marker still in the body is the preset/book still reaching the model - which is why the override is
         * `present` and not the `absent` a body-wide scan reports. A direction already failing by name keeps
         * that name: the leak line beside it says the marker and the role.
         */
        const state = (detail, outcome) => {
          const leaks = Array.isArray(detail.leaks) ? detail.leaks : [];
          if (leaks.length === 0) return outcome;
          if (wanted === "absent") return outcome === "absent" ? "present" : outcome;
          return outcome === "carried" ? "evidence_leaked" : outcome;
        };
        if (name === "memory") {
          const detail = memoryReading(turn, text, messages, memorySections, entry.fact);
          return {
            state: state(detail, memoryOutcome(detail, wanted)),
            detail: { turn: key, factLength: entry.fact.length, ...detail },
          };
        }
        if (name === "worldBook") {
          const detail = worldBookReading(turn, text, declared, entry, messages, roles);
          return {
            state: state(detail, worldBookOutcome(detail, wanted)),
            detail: { turn: key, textLength: entry.text.length, ...detail },
          };
        }
        if (presetProbeIsEmpty(entry)) return unobserved("probe_names_no_preset_marker_or_sampler");
        const detail = presetReading(text, body, entry);
        return { state: state(detail, presetOutcome(detail, wanted)), detail: { turn: key, ...detail } };
      }),
    );
  }

  return {
    ok: true,
    source: captured.source,
    claims,
    sections: { memory: memorySections, worldBook: declared.authoredTag },
    /* The instrument's own reading, beside the claims: an instrument that manufactured its evidence makes
     * every claim above it a reading of the probe. */
    instrument: instrumentFindings({ captured, probe, memorySections }),
    /* The census's own refusal, when it had one: the section halves of these readings are then blind and
     * the claim verdicts below are stated against the request text alone. */
    census: censusReason === null ? { ok: true } : { ok: false, reason: censusReason },
  };
}

/** The Host seam that carries a preset's sampler values into the provider entry the adapter writes the body from. */
const SEAM_NAME = "withPresetSampling";

/**
 * The callers of the Host's preset-sampling seam, in its production sources.
 *
 * This is the seam's own caller census, and it exists so the preset claim's carried direction is not the
 * only thing that says the sampler path is wired: `withPresetSampling` (`host/src/tavern/preset-sampling.ts`)
 * folds a preset's sampler values into the provider entry, and `models.json` is the one layer the `openai-*`
 * adapters merge into the request body last. Whoever calls it is the code that decides what the model is
 * called with, so a run can name it instead of asserting it.
 *
 * IT WAS WRITTEN AS AN EXPIRING EXEMPTION AND IT EXPIRED, which is why it is kept. Until the bound-preset
 * commit there was no caller, and the claim was allowed to report `unobserved:no_preset_bound_to_runtime`
 * ONLY while this returned an empty list. `runtime-core.internal.ts` is that caller now; the unit test
 * beside this module asserts the list is non-empty, so a product that lost the splice again would fail a
 * test rather than quietly keep reading a value nothing sends.
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
      /* The leak line names the marker literal and the role: the markers are this lane's own opaque bytes,
       * so quoting one is reproducing the instrument, not printing anything a player wrote. */
      for (const leak of detail.leaks ?? [])
        lines.push(
          `INJECTION ${label} claim=${claim.name} reading=${side} leak: marker=${leak.marker} label=${leak.label} role=${leak.role} at=${leak.at} why=${leak.reason}`,
        );
    }
  }
  for (const finding of reading.instrument ?? [])
    lines.push(
      `INJECTION ${label} instrument: probe_wrote_its_own_evidence marker=${finding.marker} label=${finding.label} role=${finding.role} turn=${finding.turn ?? "unkeyed"} why=${finding.reason}`,
    );
  if (reading.census.ok !== true) lines.push(`INJECTION ${label} claims: census_unobserved:${reading.census.reason}`);
  return lines;
}

function describeReading(reading) {
  const detail = reading.detail ?? {};
  if (reading.state === "unobserved") return "unobserved";
  if (detail.factInBody !== undefined)
    return `${reading.state} section=${detail.section ?? "none"} bytes=${detail.sectionBytes}`;
  if (detail.inBody !== undefined) return `${reading.state} bytes=${detail.sectionBytes ?? "none"}`;
  return `${reading.state} markers=${detail.markersInBody}/${detail.markersExpected} in-place=${detail.markersInPlace}/${detail.markersExpected} ${samplerText(detail.sampler)}`;
}

/**
 * The sampler as the reading prints it: the key it read, and what the body held under it.
 *
 * "not-carried" and "carried but blank" are different facts about the same key - a layer that wrote
 * `temperature: null` did not send nothing - so the value is printed rather than collapsed into a boolean.
 */
function samplerText(sampler) {
  if (sampler === null || sampler === undefined) return "sampler=none";
  const value = sampler.carried ? (sampler.empty ? "present-empty" : JSON.stringify(sampler.value)) : "not-carried";
  return `sampler.key=${sampler.key ?? "none"} sampler.value=${value}`;
}

function describeDetail(claim, detail) {
  const turn = `turn=${detail.turn}`;
  if (claim === "memory")
    return `${turn} section=${detail.section ?? "none"} bytes=${detail.sectionBytes} blocks=${detail.blocks === "" ? "none" : detail.blocks} factInBody=${detail.factInBody} factInSection=${detail.factInSection} factSection=${detail.factSection ?? "none"} factBytes=${detail.factLength}`;
  if (claim === "worldBook")
    return `${turn} bytes=${detail.sectionBytes ?? "none"} inBody=${detail.inBody} inAuthoredBlock=${detail.inAuthoredBlock} probeBytes=${detail.textLength}`;
  /* The preset reading names each block's own placement, because "3 markers in the body" and "3 markers in
   * the blocks their placement rule names" are different facts about the same three strings. */
  const blocks = detail.markers
    .map(
      (one) =>
        `${one.block}:${one.inBody ? (one.inItsBlock ? "in-place" : "out-of-place") : "absent"}@${one.index ?? "-"}/fromEnd=${one.indexFromEnd ?? "-"}/role=${one.role ?? "-"}`,
    )
    .join(",");
  return `${turn} markersInBody=${detail.markersInBody}/${detail.markersExpected} markersInPlace=${detail.markersInPlace}/${detail.markersExpected} blocks=${blocks === "" ? "none" : blocks} playerAnchored=${detail.playerAnchored} messages=${detail.bodyMessages} ${samplerText(detail.sampler)} matches=${detail.sampler.matches}`;
}
