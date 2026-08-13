import { access, link, writeFile } from "node:fs/promises";
import { withTestArtifactLock } from "./test-artifact-lock.mjs";

const [mode, lockPath, readyPath = `${lockPath}.ready`, releasePath = `${lockPath}.release`] = process.argv.slice(2);
if (!mode || !lockPath) throw new Error("invalid_lock_protocol_worker_arguments");

async function waitFor(path) {
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

if (mode === "holder") {
  await withTestArtifactLock(async () => {
    await writeFile(readyPath, "ready", "utf8");
    await waitFor(releasePath);
  }, { lockPath });
} else if (mode === "contender") {
  await writeFile(readyPath, "started", "utf8");
  try {
    await withTestArtifactLock(async () => {}, { lockPath });
  } catch (error) {
    if (error?.message !== "host_test_artifact_already_in_use") throw error;
    process.exitCode = 0;
  }
} else if (mode === "raced-contender") {
  let injected = false;
  try {
    await withTestArtifactLock(async () => {}, {
      lockPath,
      linkFile: async (from, to) => {
        await link(from, to);
        if (injected) return;
        injected = true;
        await writeFile(to, "", "utf8");
        const error = new Error("simulated_link_race");
        error.code = "EEXIST";
        throw error;
      },
    });
  } finally {
    process.stdout.write("race_complete\\n");
  }
} else {
  throw new Error(`invalid_lock_protocol_worker_mode:${mode}`);
}
