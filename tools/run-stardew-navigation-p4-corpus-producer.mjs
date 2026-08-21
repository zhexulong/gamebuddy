#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES = Object.freeze(["en-US", "zh-CN", "ja-JP"]);
export const P4A_DIGEST = "ef2f63a15e9f528cfa70dcf8602013d241503d308b8702b846578fbf76e4876a";
const VERSION = "1.6.15.24356";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const forbidden = /(?:key|label|path|alias|query|case|coordinate|route|ref|bridge|action)/iu;
const fail = (reason) => {
  throw new Error(reason);
};
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
async function regularDirectory(path) {
  try {
    return (await stat(path)).isDirectory() && !(await stat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}
async function privateChild(parent, child) {
  const root = await realpath(parent);
  const target = resolve(child);
  if (dirname(target) !== root || basename(target).startsWith(".")) fail("private_output_path_invalid");
  return target;
}
function validateExtractorLine(stdout, locale) {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0]) fail("extractor_stdout_not_single_json");
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    fail("extractor_stdout_invalid_json");
  }
  if (
    !keys(value, [
      "kind",
      "schemaVersion",
      "targetVersion",
      "locale",
      "p4aInputDigest",
      "producerInputDigest",
      "recordCount",
      "mutationCount",
      "gameLaunched",
      "nonClaim",
    ]) ||
    Object.keys(value).some((key) => forbidden.test(key)) ||
    value.kind !== "stardew_navigation_p4c_locale_extract" ||
    value.schemaVersion !== 1 ||
    value.targetVersion !== VERSION ||
    value.locale !== locale ||
    value.p4aInputDigest !== P4A_DIGEST ||
    !/^[a-f0-9]{64}$/.test(value.producerInputDigest) ||
    !Number.isInteger(value.recordCount) ||
    value.recordCount < 1 ||
    value.mutationCount !== 0 ||
    value.gameLaunched !== false ||
    typeof value.nonClaim !== "string"
  )
    fail("extractor_stdout_schema_invalid");
  return value;
}
export function combineLocaleSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length !== 3) fail("locale_snapshot_count_invalid");
  const perLocale = new Map();
  for (const snapshot of snapshots) {
    if (
      !keys(snapshot, [
        "artifactKind",
        "schemaVersion",
        "targetVersion",
        "locale",
        "p4aInputDigest",
        "producerInputDigest",
        "producerInputManifest",
        "entries",
      ]) ||
      snapshot.artifactKind !== "stardew_navigation_p4c_private_locale_snapshot" ||
      snapshot.schemaVersion !== 1 ||
      snapshot.targetVersion !== VERSION ||
      !LOCALES.includes(snapshot.locale) ||
      snapshot.p4aInputDigest !== P4A_DIGEST ||
      !/^[a-f0-9]{64}$/.test(snapshot.producerInputDigest) ||
      !Array.isArray(snapshot.producerInputManifest) ||
      !Array.isArray(snapshot.entries) ||
      perLocale.has(snapshot.locale)
    )
      fail("private_locale_snapshot_invalid");
    const map = new Map();
    for (const entry of snapshot.entries) {
      if (
        !keys(entry, ["key", "rawDisplayToken", "displayTokenKind"]) ||
        typeof entry.key !== "string" ||
        !entry.key ||
        typeof entry.rawDisplayToken !== "string" ||
        entry.displayTokenKind !== "raw_display_token_not_runtime_parsed" ||
        map.has(entry.key)
      )
        fail("private_locale_record_invalid");
      map.set(entry.key, entry.rawDisplayToken);
    }
    if (!map.size) fail("private_locale_empty");
    perLocale.set(snapshot.locale, map);
  }
  if (perLocale.size !== LOCALES.length) fail("locale_set_invalid");
  const first = perLocale.get(LOCALES[0]);
  for (const locale of LOCALES.slice(1))
    if (first.size !== perLocale.get(locale).size || [...first.keys()].some((key) => !perLocale.get(locale).has(key)))
      fail("locale_keysets_mismatch");
  const entries = [...first.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      rawDisplayTokens: Object.fromEntries(LOCALES.map((locale) => [locale, perLocale.get(locale).get(key)])),
    }));
  const localeInputs = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      {
        producerInputDigest: snapshots.find((x) => x.locale === locale).producerInputDigest,
        producerInputManifest: snapshots.find((x) => x.locale === locale).producerInputManifest,
      },
    ]),
  );
  const digest = sha(JSON.stringify(entries));
  return {
    artifactKind: "stardew_navigation_p4c_private_source_snapshot",
    schemaVersion: 1,
    targetVersion: VERSION,
    p4aInputDigest: P4A_DIGEST,
    localeInputs,
    canonicalDigest: digest,
    entries,
  };
}
export async function atomicJson(path, value, { write = writeFile, move = rename, remove = rm } = {}) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    await write(temp, JSON.stringify(value), { flag: "wx" });
    await move(temp, path);
  } finally {
    await remove(temp, { force: true }).catch(() => {});
  }
}
function invoke(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "",
      err = "";
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (err += x));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolveResult({ out, err }) : reject(new Error(`extractor_failed_${code}`)),
    );
  });
}
export async function runCoordinator({ gameRoot, privateOutput, invokeExtractor = null }) {
  if (
    !gameRoot ||
    !privateOutput ||
    !(await regularDirectory(gameRoot)) ||
    !(await regularDirectory(dirname(privateOutput)))
  )
    fail("invalid_cli_paths");
  const output = await privateChild(dirname(privateOutput), privateOutput);
  try {
    await stat(output);
    fail("private_output_already_exists");
  } catch (error) {
    if (error.message === "private_output_already_exists") throw error;
  }
  const temp = await mkdtemp(join(tmpdir(), "gamebuddy-p4c-"));
  try {
    const snapshots = [];
    const localeReports = [];
    for (const locale of LOCALES) {
      const child = await privateChild(temp, join(temp, `${locale}.json`));
      const result = invokeExtractor
        ? await invokeExtractor({ gameRoot, locale, output: child })
        : await invoke("dotnet", [
            "run",
            "--project",
            "tools/stardew-navigation-p4-corpus-producer",
            "--",
            gameRoot,
            locale,
            child,
          ]);
      const report = validateExtractorLine(result.out, locale);
      const raw = await readFile(child, "utf8");
      snapshots.push(JSON.parse(raw));
      localeReports.push({ locale, recordCount: report.recordCount, producerInputDigest: report.producerInputDigest });
    }
    const combined = combineLocaleSnapshots(snapshots);
    await atomicJson(output, combined);
    return {
      kind: "stardew_navigation_p4c_corpus_producer_report",
      schemaVersion: 1,
      targetVersion: VERSION,
      p4aInputDigest: P4A_DIGEST,
      canonicalDigest: combined.canonicalDigest,
      localeRecords: localeReports,
      toolVersion: "p4c-producer-v1",
      mutationCount: 0,
      gameLaunched: false,
      nonClaim:
        "Private raw display-token extraction only; not corpus selection, product search, runtime labels, or Agent consumption.",
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--game-root" || args[2] !== "--private-output")
    fail("usage: --game-root <root> --private-output <file>");
  console.log(JSON.stringify(await runCoordinator({ gameRoot: args[1], privateOutput: args[3] })));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
