#!/usr/bin/env node
import { execFile } from "node:child_process";
/** Exact-target source realization for the bounded existing-ladder M8 primitive. */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  disposeTargetAssembly,
  resolveLockedToolPath,
  targetAssembly,
  verifySnapshot,
} from "./stardew-portfolio-m8-elevator-source-realization.mjs";

const exec = promisify(execFile);
const ACTION = "use_mine_ladder",
  TOPOLOGY = "single_player_native_companion";
const TARGET = {
  relativeFileName: "Stardew Valley.dll",
  fileVersion: "1.6.15.24356",
  productVersion: "1.6.15.24356",
  length: 6268416,
  sha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
};
const ANCHORS = [
  {
    anchorId: "mine_ladder_interaction_guard",
    relativePath: "StardewValley/Locations/MineShaft.cs",
    locate: "public override bool checkAction",
    needle: "case 173:",
    semanticRole: "normal_player_fresh_existing_ladder_interaction_guard",
  },
  {
    anchorId: "mine_ladder_next_floor_commit",
    relativePath: "StardewValley/Locations/MineShaft.cs",
    locate: "public override bool checkAction",
    needle: "Game1.enterMine(mineLevel + 1);",
    semanticRole: "case_173_immediate_next_floor_native_commit",
  },
  {
    anchorId: "mine_ladder_native_warp",
    relativePath: "StardewValley/Game1.cs",
    locate: "public static void enterMine(int whatLevel, int? forceLayout = null)",
    needle: "warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2);",
    semanticRole: "native_enter_mine_next_floor_warp",
  },
  {
    anchorId: "mine_ladder_spawn_boundary",
    relativePath: "StardewValley/Locations/MineShaft.cs",
    locate: "public void createLadderDown(int x, int y, bool forceShaft = false)",
    needle: "createLadderDownEvent[new Point(x, y)]",
    semanticRole: "ladder_creation_external_to_primitive",
  },
];
const EXCLUDED = [
  "combat",
  "ladder spawning",
  "rock breaking",
  "generic mine travel",
  "arbitrary enterMine",
  "UI/input",
  "save mutation",
];
const sha256 = (x) => createHash("sha256").update(x).digest("hex");
const canonical = (x) =>
  Array.isArray(x)
    ? `[${x.map(canonical).join(",")}]`
    : x && typeof x === "object"
      ? `{${Object.keys(x)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)
          .join(",")}}`
      : JSON.stringify(x);
function fail(m) {
  throw new Error(m);
}
function bodyEnd(s, b) {
  let d = 0,
    state = "code";
  for (let i = b; i < s.length; i++) {
    const c = s[i],
      n = s[i + 1];
    if (state === "line") {
      if (c === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "string") {
      if (c === "\\") i++;
      else if (c === '"') state = "code";
      continue;
    }
    if (c === "/" && n === "/") {
      state = "line";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i++;
      continue;
    }
    if (c === '"') {
      state = "string";
      continue;
    }
    if (c === "{") d++;
    else if (c === "}" && --d === 0) return i + 1;
  }
  fail("anchor declaration unterminated");
}
function slice(bytes, locate) {
  const s = bytes.toString(),
    at = s.indexOf(locate);
  if (at < 0 || s.indexOf(locate, at + locate.length) >= 0)
    fail(`required declaration missing or non-unique: ${locate}`);
  const b = s.indexOf("{", at);
  if (b < 0) fail(`required declaration has no body: ${locate}`);
  const e = bodyEnd(s, b);
  return [at, e];
}
export function extractAnchors(files) {
  return ANCHORS.map((a) => {
    const bytes = files[a.relativePath];
    if (!Buffer.isBuffer(bytes)) fail(`source missing: ${a.relativePath}`);
    const source = bytes.toString("utf8");
    const [start, end] = slice(bytes, a.locate);
    const text = source.slice(start, end);
    const part = Buffer.from(text, "utf8");
    if (text.split(a.needle).length - 1 !== 1) fail(`required anchor missing or non-unique: ${a.anchorId}`);
    if (
      a.anchorId === "mine_ladder_interaction_guard" &&
      (!text.includes("who.IsLocalPlayer") || !text.includes("case 173:") || !text.includes("return true;"))
    )
      fail("ladder interaction guard incomplete");
    if (a.anchorId === "mine_ladder_next_floor_commit" && !text.includes('playSound("stairsdown")'))
      fail("ladder commit continuation incomplete");
    return {
      anchorId: a.anchorId,
      relativePath: a.relativePath,
      declaration: a.locate,
      startByte: Buffer.byteLength(source.slice(0, start), "utf8"),
      endByte: Buffer.byteLength(source.slice(0, end), "utf8"),
      fileSha256: sha256(bytes),
      sliceSha256: sha256(part),
      needle: a.needle,
      semanticRole: a.semanticRole,
    };
  });
}
async function sourceTree(root) {
  const out = {};
  async function walk(dir, rel = "") {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) fail("decompiler output reparse point");
      if (e.isDirectory()) await walk(dir, r);
      else if (r.endsWith(".cs")) out[r] = await readFile(path.join(dir, r));
    }
  }
  await walk(root);
  return out;
}
async function decompile(target) {
  await verifySnapshot(target);
  const out = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-m8-ladder-"));
  try {
    await exec(
      resolveLockedToolPath(),
      ["--disable-updatecheck", "-p", "--nested-directories", "-o", out, target.path],
      { windowsHide: true },
    );
    return { out, files: await sourceTree(out) };
  } catch (e) {
    await rm(out, { recursive: true, force: true });
    throw e;
  }
}
export function validateDossier(d) {
  if (
    canonical(d.target) !== canonical(TARGET) ||
    d.actionId !== ACTION ||
    d.topology !== TOPOLOGY ||
    d.conclusion?.primitiveSourceRealizationStatus !== "realized"
  )
    fail("invalid or unauthorized ladder realization dossier");
  if (!Array.isArray(d.anchors) || d.anchors.length !== ANCHORS.length) fail("ladder anchor count drift");
  const boundary = d.semanticBoundary?.contextualEquivalence;
  if (
    typeof boundary !== "string" ||
    !boundary.includes("current MineShaft Buildings layer") ||
    !boundary.includes("exactly mineLevel + 1") ||
    !boundary.includes("without UI ingress pose") ||
    /\b(?:adjacent|adjacency|proximity|grab[ -]?tile|facing|standing)\b/i.test(boundary)
  )
    fail("ladder direct facility boundary invalid");
  return true;
}
export async function mint({ gamePath, output }) {
  if (!output) fail("output required");
  const t = await targetAssembly(gamePath);
  try {
    const r = await decompile(t);
    try {
      const anchors = extractAnchors(r.files),
        d = {
          schemaVersion: 1,
          artifactKind: "portfolio_primitive_exact_target_source_realization",
          realizationId: "portfolio_m8_ladder_source_realization_v1",
          actionId: ACTION,
          topology: TOPOLOGY,
          target: TARGET,
          sourceManifest: {
            csharpFileCount: Object.keys(r.files).length,
            canonicalSha256: sha256(
              `${Object.keys(r.files)
                .sort()
                .map((k) => `${k}\t${sha256(r.files[k])}`)
                .join("\n")}\n`,
            ),
          },
          anchors,
          semanticBoundary: {
            contextualEquivalence:
              "A fresh existing ladder facility in the current MineShaft Buildings layer supports the bounded direct ladder semantic: it derives exactly mineLevel + 1 without UI ingress pose, player movement, or arbitrary enterMine authority; normal case-173 interaction remains provenance only.",
            excluded: EXCLUDED,
          },
          conclusion: {
            primitiveSourceRealizationStatus: "realized",
            projectionState: "eligible_for_separate_projection_review",
            liveState: "not_performed",
            nonClaim: "This dossier does not claim combat, ladder creation, capability publication, or live closure.",
          },
        };
      validateDossier(d);
      await writeFile(path.resolve(output), `${JSON.stringify(d, null, 2)}\n`);
      return d;
    } finally {
      await rm(r.out, { recursive: true, force: true });
    }
  } finally {
    await disposeTargetAssembly(t);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gamePath = process.env.GAMEBUDDY_STARDEW_GAME_PATH;
  const output = process.env.GAMEBUDDY_PORTFOLIO_M8_LADDER_DOSSIER_PATH;
  if (!gamePath || !output) {
    console.error(
      "stardew-portfolio-m8-ladder-source-realization: GAMEBUDDY_STARDEW_GAME_PATH and GAMEBUDDY_PORTFOLIO_M8_LADDER_DOSSIER_PATH are required.",
    );
    process.exitCode = 1;
  } else {
    mint({ gamePath, output })
      .then((dossier) =>
        console.log(
          JSON.stringify(
            {
              actionId: dossier.actionId,
              anchorCount: dossier.anchors.length,
              primitiveSourceRealizationStatus: dossier.conclusion.primitiveSourceRealizationStatus,
              projectionState: dossier.conclusion.projectionState,
              liveState: dossier.conclusion.liveState,
            },
            null,
            2,
          ),
        ),
      )
      .catch((error) => {
        console.error(`stardew-portfolio-m8-ladder-source-realization: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
