import { cleanupWindowsReleaseOwnedScratch } from "./windows-release-bootstrap-scratch.internal.mjs";
import { assertProtectedWindowsReleaseCiEnvironment } from "./node-runtime-release-acquisition.mjs";

async function main() {
  assertProtectedWindowsReleaseCiEnvironment();
  await cleanupWindowsReleaseOwnedScratch();
}

const scriptPath = new URL(import.meta.url).pathname;
const invokedPath = process.argv[1] === undefined ? undefined : new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).pathname;
if (invokedPath === scriptPath) await main();
