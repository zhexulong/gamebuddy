/**
 * Model-graded judgement for the historian's prose — rubric obligations 9 and 10.
 *
 * `design/architecture/historian-prompt-rubric.md` classifies two of its obligations as "not mechanically
 * decidable" (does the memory read as the companion's own recollection; is the compression worth its cost) and
 * states that until a grader exists, a prompt change may only claim "1-7 green, 9-10 unjudged". This is that
 * grader: a fixed, blind question put to the same model family the product uses, scored against stated
 * criteria, so a judgement is at least reproducible and comparable between two arms.
 *
 * It is a MODEL's judgement, not a person's. The report says so, and the criteria are printed with the scores
 * so a reader can disagree with a specific one.
 *
 *   node tools/grade-historian-voice.mjs [--fixture <path>] [--report <path>]
 *
 * Exit codes: 0 judged, 3 blocked (no credential), 2 failed.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DEFAULT_FIXTURE = "tools/fixtures/historian-prompt-ab/voice-change.json";
const BASE_URL = process.env.GAMEBUDDY_CPA_OAI_BASE_URL ?? "http://127.0.0.1:8317/v1";
const MODEL = process.env.GAMEBUDDY_GRADER_MODEL ?? "deepseek-v4-flash";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at < 0 ? fallback : argv[at + 1];
};
const fixturePath = resolve(repo, flag("--fixture", DEFAULT_FIXTURE));
const reportPath = flag("--report", undefined);

const CRITERIA = [
  [
    "voice",
    "It reads as the companion's own recollection, in her voice (first person for her, second for the player).",
  ],
  [
    "no_role_labels",
    "It contains no transcript apparatus: no role labels such as 'the player'/'the user'/'the assistant', and no message ordinals.",
  ],
  [
    "substance",
    "It keeps what a companion would actually need later (events, preferences, feelings) rather than generic filler.",
  ],
  [
    "compression_worth_it",
    "Its length is justified by what it conveys; nothing is padded, and nothing essential is dropped.",
  ],
];

const apiKey = process.env.CPA_OAI_API_KEY;
if (apiKey === undefined || apiKey.trim().length === 0) {
  process.stdout.write(`${JSON.stringify({ verdict: "blocked", reason: "credential_absent" })}\n`);
  process.exit(3);
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const arms = Array.isArray(fixture.arms) ? fixture.arms : [];
if (arms.length < 2) {
  process.stdout.write(`${JSON.stringify({ verdict: "failed", reason: "fixture_needs_two_arms" })}\n`);
  process.exit(2);
}

const prompt = (sample) =>
  [
    "You are judging one excerpt of a companion character's long-term memory, written by an AI summariser.",
    "Judge only what is on the page. Do not speculate about the code that produced it.",
    "",
    "Score each criterion 1-5 (1 = fails badly, 5 = excellent) and give one short reason per criterion:",
    ...CRITERIA.map(([name, description], index) => `${index + 1}. ${name}: ${description}`),
    "",
    "Reply with JSON only, in this exact shape:",
    '{"scores":{"voice":0,"no_role_labels":0,"substance":0,"compression_worth_it":0},"reasons":{"voice":"","no_role_labels":"","substance":"","compression_worth_it":""}}',
    "",
    "Excerpt:",
    '"""',
    sample,
    '"""',
  ].join("\n");

const judge = async (sample) => {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt(sample) }],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`provider returned ${response.status}`);
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("provider returned no content");
  return JSON.parse(text);
};

const results = [];
for (const arm of arms) {
  const text = typeof arm.text === "string" ? arm.text : "";
  // Each arm is judged in its own call and the arm's identity is never sent: the model sees prose, not which
  // variant produced it.
  const judged = await judge(text);
  const scores = judged?.scores ?? {};
  const total = CRITERIA.reduce((sum, [name]) => sum + (Number(scores[name]) || 0), 0);
  results.push({ variant: arm.variant, total, scores, reasons: judged?.reasons ?? {} });
  process.stderr.write(`[voice-grader] ${arm.variant}: total ${total}/${CRITERIA.length * 5}\n`);
}

const ranked = [...results].sort((left, right) => right.total - left.total);
const report = {
  schema: "gamebuddy_historian_voice_grade/v1",
  fixture: fixturePath.replace(`${repo}\\`, "").replace(`${repo}/`, ""),
  grader: { kind: "model", model: MODEL, baseUrl: BASE_URL, temperature: 0, criteria: CRITERIA.map(([name]) => name) },
  arms: results,
  verdict: ranked[0].total === ranked[1]?.total ? "no_measurable_difference" : `${ranked[0].variant}_rated_higher`,
  caveat:
    "A model's judgement, not a person's. The criteria and the per-criterion reasons are printed so a reader can disagree with a specific one; this does not replace human review of the prompt.",
};

if (reportPath !== undefined) {
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(
  `${JSON.stringify({ verdict: report.verdict, arms: results.map((r) => `${r.variant}=${r.total}`) })}\n`,
);
