import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
export const BAIT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  topology: "native_local_player_fixture",
  qualifiedItemId: "(O)685",
  rawItemId: "685",
  name: "Bait",
  category: -21,
  type: "Basic",
  expectedObjectsXnbSha256: "f29fcd49bc979537645ea0dd8735c53acb39e3b8299d9ee8258ad33c4822ff30",
  expectedObjectsDigest: "b413b73d64a78e3bb5d638d1d4927140a98edb2e5921534fd043e8c6b4aa9827",
});
export function validateBaitProbe(probe) {
  const objects = probe?.objectsContent;
  if (objects?.state !== "loaded" || objects.digest !== BAIT_CONTRACT.expectedObjectsDigest || !Array.isArray(objects.entries)) return "objects_content_probe_invalid";
  const bait = objects.entries.find((entry) => entry?.itemId === BAIT_CONTRACT.rawItemId);
  if (!bait || bait.unknownFields?.length || bait.name !== BAIT_CONTRACT.name || bait.category !== BAIT_CONTRACT.category || bait.type !== BAIT_CONTRACT.type) return "bait_content_contract_mismatch";
  return null;
}
if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  const index = process.argv.indexOf("--game-path");
  if (index < 0 || !process.argv[index + 1]) throw new Error("missing_game_path");
  const gamePath = process.argv[index + 1];
  const objectsPath = resolve(gamePath, "Content", "Data", "Objects.xnb");
  const sha256 = createHash("sha256").update(await readFile(objectsPath)).digest("hex");
  if (sha256 !== BAIT_CONTRACT.expectedObjectsXnbSha256) throw new Error("objects_xnb_hash_mismatch");
  const { stdout } = await execFileAsync("dotnet", ["run", "--project", resolve("tools/stardew-content-probe/ContentProbe.csproj"), "--", resolve(gamePath)], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const failure = validateBaitProbe(probe);
  if (failure) throw new Error(failure);
  console.log(JSON.stringify({ state: "verified", artifactKind: "stardew_native_local_bait_content_contract_v1", objectsXnbSha256: sha256, objectsDigest: probe.objectsContent.digest, contract: BAIT_CONTRACT }));
}
