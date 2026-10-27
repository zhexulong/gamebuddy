import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { projectHistorianModel } from "./magic-context-historian-projection.internal.js";

const field = (document: unknown, path: readonly string[]): unknown => {
  let current: unknown = document;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

test("a model change reaches both files the historian reads, and nothing else in them", async () => {
  const runtimeCwd = await mkdtemp(join(tmpdir(), "historian-projection-"));
  try {
    // A mount writes both files first; the projection then corrects only the two historian keys.
    await projectHistorianModel({ runtimeCwd, model: "cpa-oai/deepseek-v4.1-flash", thinkingLevel: "high" });
    const firstProject = JSON.parse(await readFile(join(runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8"));
    assert.equal(field(firstProject, ["historian", "model"]), "cpa-oai/deepseek-v4.1-flash");
    assert.equal(field(firstProject, ["historian", "thinking_level"]), "high");

    // A player switches model on the live mount.
    await projectHistorianModel({ runtimeCwd, model: "openai/gpt-5.5", thinkingLevel: "max" });

    const project = JSON.parse(await readFile(join(runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8"));
    const user = JSON.parse(await readFile(join(runtimeCwd, "config", "cortexkit", "magic-context.jsonc"), "utf8"));
    // Both scopes carry the new fact: the historian resolves its model from the user-scope file, and the project file must not
    // contradict it.
    assert.equal(field(project, ["historian", "model"]), "openai/gpt-5.5");
    assert.equal(field(project, ["historian", "thinking_level"]), "max");
    assert.equal(field(user, ["historian", "pi", "model"]), "openai/gpt-5.5");
    assert.equal(field(user, ["historian", "pi", "thinking_level"]), "max");
  } finally {
    await rm(runtimeCwd, { recursive: true, force: true });
  }
});

test("keys the projection does not own survive the rewrite", async () => {
  const runtimeCwd = await mkdtemp(join(tmpdir(), "historian-projection-keep-"));
  try {
    await projectHistorianModel({ runtimeCwd, model: "cpa-oai/deepseek-v4.1-flash", thinkingLevel: "high" });
    const projectPath = join(runtimeCwd, ".cortexkit", "magic-context.jsonc");
    // The mount's own gates live in the same file; a projection that dropped them would silently change a security surface.
    const { writeFile } = await import("node:fs/promises");
    const existing = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(
      projectPath,
      JSON.stringify({ ...existing, enabled: true, embedding: { provider: "off" } }, null, 2),
    );
    await projectHistorianModel({ runtimeCwd, model: "openai/gpt-5.5", thinkingLevel: "max" });
    const after = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(after.enabled, true);
    assert.deepEqual(after.embedding, { provider: "off" });
    assert.equal(field(after, ["historian", "model"]), "openai/gpt-5.5");
  } finally {
    await rm(runtimeCwd, { recursive: true, force: true });
  }
});
