#!/usr/bin/env node
/**
 * The reviewed card's own prose, judged by the harness's own content gates, with
 * no provider turn and no edit to the card.
 *
 * The three content gates normally judge a LIVE reply (see
 * `core/companion-experience.mjs` and `chat/run-chat-live-audit.mjs`). The card's
 * authored text anchors the model's voice, so it is judged too — but by the ruler
 * that answers the question the text actually has to answer:
 *
 *   - `first_mes` and every `alternate_greetings` entry are AUTHORED OPENINGS:
 *     author text shown verbatim once, before the player has spoken. They are
 *     judged by `opening_legibility` (can the player read it on the measured
 *     400x800 first screen), NOT by the reply ladder. Judging an opening with the
 *     reply ladder is the cry-wolf failure this split exists to remove.
 *   - `mes_example` companion turns are authored SCENE TURNS: how long a full reply
 *     may be. They keep the reply ladder's task rung.
 *
 * Read-only: the card belongs to its owner. Exits non-zero when any gate fails, so
 * it is usable as a check; it never spends a provider turn.
 */

import { readFileSync } from "node:fs";

import {
  evaluateFirstPersonAnchoring,
  evaluateHygiene,
  evaluateOpeningLegibility,
  evaluatePacing,
} from "../core/companion-experience.mjs";
import { liveRunPersonaPaths } from "../core/persona.mjs";

const { cardPath } = liveRunPersonaPaths();
const card = JSON.parse(readFileSync(cardPath, "utf8"));
const data = card.data ?? card;
const names = [data.name].filter((value) => typeof value === "string" && value.length > 0);

const companionSegments = (example) =>
  String(example)
    .split(/\{\{char\}\}\s*:/)
    .slice(1)
    .map((segment) => segment.split(/\{\{user\}\}\s*:/)[0].trim())
    .filter((segment) => segment.length > 0);

const rows = [];
const check = (label, text, kind) => {
  const anchoring = evaluateFirstPersonAnchoring({ text, companionNames: names });
  const judgment =
    kind === "opening" ? evaluateOpeningLegibility({ text }) : evaluatePacing({ text, scenario: "task" });
  const hygiene = evaluateHygiene({ text });
  rows.push({ label, kind, chars: [...text].length, anchoring, judgment, hygiene });
};

check("first_mes", String(data.first_mes ?? ""), "opening");
for (const [index, greeting] of (data.alternate_greetings ?? []).entries())
  check(`alternate_greeting_${index + 1}`, String(greeting), "opening");
for (const [index, example] of String(data.mes_example ?? "")
  .split(/<START>/)
  .entries()) {
  const segments = companionSegments(example).join("\n");
  if (segments.length > 0) check(`mes_example_${index + 1}`, segments, "scene turn");
}

const pad = (value, width) => String(value).padEnd(width);
console.log(`${cardPath}\n`);
console.log(
  `${pad("item", 26)}${pad("kind", 12)}${pad("chars", 7)}${pad("question", 44)}${pad("measured", 18)}${pad("verdict", 9)}anchoring / hygiene`,
);
for (const row of rows) {
  const measured =
    row.kind === "opening"
      ? `${row.judgment.measured.heightPx}/${row.judgment.bound.firstScreenPx}px`
      : `${row.judgment.measured.chars}/${row.judgment.bound.maxChars}cp`;
  console.log(
    `${pad(row.label, 26)}${pad(row.kind, 12)}${pad(row.chars, 7)}${pad(row.judgment.rule, 22)}${pad(measured, 18)}${pad(row.judgment.verdict, 9)}${row.anchoring.verdict} / ${row.hygiene.verdict}`,
  );
  for (const finding of [...row.anchoring.matched, ...row.judgment.matched, ...row.hygiene.matched])
    console.log(`    ${finding.rule}: ${JSON.stringify(finding.text ?? finding.heightPx ?? "")}`);
}

const failed = rows.filter(
  (row) => row.anchoring.verdict === "fail" || row.judgment.verdict === "fail" || row.hygiene.verdict === "fail",
);
console.log(`\n${failed.length} of ${rows.length} items fail at least one gate`);
process.exit(failed.length === 0 ? 0 : 1);
