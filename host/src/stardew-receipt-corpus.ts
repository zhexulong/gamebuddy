/**
 * THE RECEIPT CORPUS: the schema of the committed file, and the readings every consumer shares.
 *
 * WHY A MODULE RATHER THAN A READER IN EACH PLACE. The corpus is produced by a tool
 * (`tools/harvest-stardew-receipts.mjs`) and consumed by the Host's contract tests, so the schema, the staleness digest
 * and the digest's own definition of "the producer's code" are facts that cross that boundary. One declaration here,
 * imported by both ends (the tool through `host/dist-test`), is what keeps the producer's file and the consumer's
 * reading of it the same shape.
 *
 * THE STALENESS DIGEST EXISTS FOR ONE FAILURE: a corpus that stops being re-harvested is a gate that stopped reading.
 * The corpus is the Mod's real output at the moment it was harvested; when the Mod's receipt-composing code changes and
 * nobody re-runs the harvester, every test over the corpus keeps passing while the producer moves on - which is exactly
 * the drift the corpus exists to catch, one level up. `round93` is the measured case: five receipts carried fields the
 * Host's rows did not declare, and every fixture-based test was green because the fixture had been written from the
 * same belief as the row.
 */

import { createHash } from "node:crypto";

export const RECEIPT_CORPUS_SCHEMA = "gamebuddy-stardew-receipt-corpus/v1";

/** One terminal receipt, in the Mod's own field order, with the run it was harvested from. */
export type ReceiptCorpusEntry = Readonly<{
  /** The run directory the receipt came out of, e.g. `2026-11-22T13-10-47-678Z-multiday_routine`. */
  run: string;
  actionId: string;
  state: string;
  reasonCode: string;
  evidence: Readonly<Record<string, string>>;
}>;

export type ReceiptCorpus = Readonly<{
  generator: string;
  schema: string;
  modSourceDigest: string;
  runs: readonly Readonly<{ run: string; receipts: number }>[];
  receipts: readonly ReceiptCorpusEntry[];
}>;

/** One Mod source file: its repository-relative path and its text. */
export type ModSource = Readonly<{ path: string; source: string }>;

/**
 * The digest's own view of a C# source: comments removed, code kept.
 *
 * A COMMENT EDIT IS NOT A PRODUCER CHANGE, so it must not demand a fresh live run. This reads only the two comment
 * forms that cannot be confused with code - a `/* … *\/` block, and a line whose first non-space characters are `//` -
 * and deliberately does NOT try to strip a `//` inside a string literal: the digest only has to answer "did the
 * producer's code text change", and a wrong answer there costs a re-harvest, never a false green.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

/**
 * The digest the corpus records and every consumer re-derives: the Mod's `.cs` sources at the Mod root, comments
 * removed, sorted by path so directory order cannot change it.
 *
 * The population is the files at the Mod root rather than the whole tree, because that is where the execution
 * controller and every handler that composes a receipt live (`farmhandexecutioncontroller*.cs`), while the tree also
 * holds the Mod's own test project, whose edits never change a receipt.
 */
export function modSourceDigest(sources: readonly ModSource[]): string {
  const hash = createHash("sha256");
  for (const source of [...sources].sort((left, right) => left.path.localeCompare(right.path)))
    hash.update(`${source.path}\u0000${withoutComments(source.source)}\u0000`);
  return `sha256:${hash.digest("hex")}`;
}

/** The corpus as a file's bytes: a receipt list that names its generator and the producer it was harvested from. */
export function parseReceiptCorpus(text: string): ReceiptCorpus {
  const parsed = JSON.parse(text) as Partial<ReceiptCorpus>;
  const absent = (["generator", "schema", "modSourceDigest", "runs", "receipts"] as const).filter(
    (key) => parsed[key] === undefined,
  );
  if (absent.length > 0) throw new Error(`the receipt corpus declares no ${absent.join(", ")}`);
  if (parsed.schema !== RECEIPT_CORPUS_SCHEMA)
    throw new Error(`the receipt corpus is ${String(parsed.schema)}, not ${RECEIPT_CORPUS_SCHEMA}`);
  return parsed as ReceiptCorpus;
}
