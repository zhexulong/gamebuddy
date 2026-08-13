import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "tools", "verify-stardew-scaffold.ps1");

async function runChecker(projectRoot) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProjectRoot", projectRoot],
      { cwd: root, stdio: "pipe", windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, output }));
  });
}

async function withStardewFixture(mutate, verify) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-scaffold-"));
  try {
    await cp(resolve(root, "integrations", "stardew"), resolve(fixtureRoot, "integrations", "stardew"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await mutate(resolve(fixtureRoot, "integrations", "stardew"));
    await verify(await runChecker(fixtureRoot));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function replace(path, from, to) {
  const source = await readFile(path, "utf8");
  assert.ok(source.includes(from), `fixture mutation anchor not found: ${from}`);
  await writeFile(path, source.replace(from, to));
}

test("scaffold checker accepts the intentional partial ModEntry declaration", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /public sealed partial class ModEntry : Mod/);
  assert.doesNotMatch(source, /"public sealed class ModEntry : Mod"/);
  const result = await runChecker(root);
  assert.equal(result.code, 0, result.output);
});

test("scaffold checker rejects a non-partial authoritative ModEntry declaration", async () => {
  await withStardewFixture(
    async (modRoot) =>
      replace(
        join(modRoot, "ModEntry.cs"),
        "public sealed partial class ModEntry : Mod",
        "public sealed class ModEntry : Mod",
      ),
    ({ code, output }) => {
      assert.notEqual(code, 0);
      assert.match(
        output,
        /missing required lifecycle\/local-player binding text: public sealed partial class ModEntry : Mod/,
      );
    },
  );
});

test("scaffold checker rejects a missing primary lifecycle ingress", async () => {
  await withStardewFixture(
    async (modRoot) =>
      replace(
        join(modRoot, "ModEntry.cs"),
        "public override void Entry(IModHelper helper)",
        "public override void Start(IModHelper helper)",
      ),
    ({ code, output }) => {
      assert.notEqual(code, 0);
      assert.match(
        output,
        /missing required lifecycle\/local-player binding text: public override void Entry\(IModHelper helper\)/,
      );
    },
  );
});

test("scaffold checker rejects forbidden embodiment surfaces anywhere in the Mod source tree", async () => {
  await withStardewFixture(
    async (modRoot) =>
      writeFile(
        join(modRoot, "ForbiddenFixture.cs"),
        'internal static class ForbiddenFixture { private const string Marker = "new Farmer"; }\n',
      ),
    ({ code, output }) => {
      assert.notEqual(code, 0);
      assert.match(output, /forbidden Phase 1 surface: new Farmer/);
    },
  );
});
