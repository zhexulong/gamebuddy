import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const script = resolve("tools/check-stardew-portfolio-command-path-charter.mjs");
const fixturePath = resolve("tools/stardew-portfolio-command-path-charter.json");

async function run(args) {
  const child = await import("node:child_process").then(
    ({ spawn }) =>
      new Promise((done, reject) => {
        const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => done({ code, stdout, stderr }));
      }),
  );
  return child;
}

test("charter checker verifies the pinned design/16 authority hash before reporting progress", async () => {
  const pass = await run([]);
  assert.equal(pass.code, 0);
  assert.equal(JSON.parse(pass.stdout).state, "pending_focused_source_realization");

  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-command-path-charter-"));
  try {
    const model = JSON.parse(await readFile(fixturePath, "utf8"));
    model.scopeAuthority.sha256 = "a".repeat(64);
    const modelPath = join(directory, "tampered-charter.json");
    await writeFile(modelPath, `${JSON.stringify(model)}\n`, "utf8");
    const failed = await run(["--model", modelPath]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /portfolio_command_path_authority_hash_mismatch/);

    const unknownImpact = JSON.parse(await readFile(fixturePath, "utf8"));
    unknownImpact.sourceImpacts = [
      {
        impactId: "unknown_source_impact",
        traceFamilyId: "portfolio_m1_leave_and_return_route",
        sourceAnchor: "StardewValley/Example.cs:1",
        disposition: "unknown_blocking",
        rationale: "Target-version branch needs focused semantic review.",
        exclusionId: null,
      },
    ];
    const unknownImpactPath = join(directory, "unknown-impact-charter.json");
    await writeFile(unknownImpactPath, `${JSON.stringify(unknownImpact)}\n`, "utf8");
    const unknownFailed = await run(["--model", unknownImpactPath]);
    assert.equal(unknownFailed.code, 2);
    assert.equal(JSON.parse(unknownFailed.stdout).state, "blocked_pending_source_impact_disposition");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
