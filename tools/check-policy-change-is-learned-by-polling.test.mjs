import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkPolicyReads,
  configReadsIn,
  formatReport,
  modSourceFiles,
} from "./check-policy-change-is-learned-by-polling.mjs";

/**
 * The falsifier for `check-policy-change-is-learned-by-polling`.
 *
 * Every case here drives the gate's OWN readers over a throwaway tree, so the proof is the gate's verdict and not a
 * second implementation of its rules. A tree is the cheapest population there is: the real Mod has exactly one read,
 * and the readings that matter are the ones nobody has written yet.
 */
const STARTUP_LOAD = `public sealed class ModEntry
{
    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        this.ticker = new Ticker();
    }

    private void OnUpdateTicked()
    {
        this.ticker.Update();
    }
}
`;

const STARTUP_LOAD_WITH_ANOTHER_CLASS = (second) => `${STARTUP_LOAD}\npublic sealed class Ticker\n{\n${second}\n}\n`;

function withTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-policy-reads-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, "integrations", "stardew", path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents, "utf8");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the shipped shape passes and prints its three counts", () => {
  withTree({ "ModEntry.cs": STARTUP_LOAD }, (root) => {
    const verdict = checkPolicyReads(root);
    assert.equal(verdict.status, "passed", JSON.stringify(verdict.findings));
    assert.equal(verdict.examined, 1);
    assert.equal(verdict.atStartup, 1);
    assert.equal(verdict.periodic, 0);
    assert.match(formatReport(verdict), /files examined 1 · config reads examined 1 · at startup 1 · periodic 0/u);
  });
});

test("a read in another class is periodic, and the finding names it", () => {
  withTree(
    {
      "ModEntry.cs": STARTUP_LOAD,
      "PolicyPoller.cs": `public sealed class PolicyPoller
{
    private void Update() => this.helper.ReadConfig<ModConfig>();
}
`,
    },
    (root) => {
      const verdict = checkPolicyReads(root);
      assert.equal(verdict.status, "failed");
      assert.equal(verdict.periodic, 1);
      assert.deepEqual(
        verdict.findings.map((finding) => finding.replace(/:\d+:\d+$/u, "")),
        ["policy_change_is_learned_by_polling:integrations/stardew/PolicyPoller.cs"],
        "the finding names the member, which is what the next reader has to fix",
      );
      assert.equal(
        verdict.reads.find((read) => !read.atStartup)?.site.startsWith("integrations/stardew/PolicyPoller.cs:"),
        true,
      );
    },
  );
});

test("a read in a second method of ModEntry is periodic: only the Entry body is the startup load", () => {
  withTree(
    {
      "ModEntry.cs": STARTUP_LOAD_WITH_ANOTHER_CLASS(
        "    private void Poll()\n    {\n        this.config = this.helper.ReadConfig<ModConfig>();\n    }",
      ),
    },
    (root) => {
      const verdict = checkPolicyReads(root);
      assert.equal(verdict.status, "failed", "a read that is not in Entry can run on a frame, a timer or a message");
      assert.equal(verdict.atStartup, 1);
      assert.equal(verdict.periodic, 1);
    },
  );
});

test("a raw file read of the document counts, and a sibling file under the same config object does not", () => {
  withTree(
    {
      "ModEntry.cs": STARTUP_LOAD,
      "Reads.cs": `public sealed class Reads
{
    private void Reload() => System.IO.File.ReadAllText(System.IO.Path.Combine(root, "config.json"));

    private void ReadManifest() => System.IO.File.ReadAllText(this.config.ManifestPath);
}
`,
    },
    (root) => {
      const reads = configReadsIn(
        "Reads.cs",
        `public sealed class Reads
{
    private void Reload() => System.IO.File.ReadAllText(System.IO.Path.Combine(root, "config.json"));

    private void ReadManifest() => System.IO.File.ReadAllText(this.config.ManifestPath);
}
`,
      );
      assert.equal(
        reads.length,
        1,
        "the config OBJECT is not the config DOCUMENT: a manifest read is a different file",
      );
      assert.equal(reads[0].atStartup, false);
      assert.equal(checkPolicyReads(root).status, "failed");
    },
  );
});

test("the tests directory is not the running Mod", () => {
  withTree(
    {
      "ModEntry.cs": STARTUP_LOAD,
      "tests/SomeTests.cs": `public sealed class SomeTests
{
    private string Read() => System.IO.File.ReadAllText("config.json");
}
`,
    },
    (root) => {
      assert.deepEqual(modSourceFiles(root), ["integrations/stardew/ModEntry.cs"]);
      assert.equal(checkPolicyReads(root).status, "passed");
    },
  );
});

test("no reads at all is BLOCKED, not green: a policy set before launch could never arrive", () => {
  withTree({ "ModEntry.cs": "public sealed class ModEntry { }\n" }, (root) => {
    const verdict = checkPolicyReads(root);
    assert.equal(verdict.status, "blocked");
    assert.equal(verdict.examined, 0);
    assert.match(verdict.reason, /examined 0/u);
  });
});

test("a read that is not the startup load, with no startup load anywhere, is BLOCKED by name", () => {
  withTree(
    {
      "PolicyPoller.cs": `public sealed class PolicyPoller
{
    private void Update() => this.helper.ReadConfig<ModConfig>();
}
`,
    },
    (root) => {
      const verdict = checkPolicyReads(root);
      assert.equal(verdict.status, "blocked");
      assert.match(verdict.reason, /startup load is missing/u);
    },
  );
});
