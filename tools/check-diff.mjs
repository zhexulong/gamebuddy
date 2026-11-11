// Whitespace-error check: `git diff --check` over the index against HEAD, so a commit cannot land trailing
// whitespace or a conflict marker that no reviewer reads.
//
// red-proof: inject  a tracked file edited to end `beta` with three trailing spaces ->
//                    `proof.txt:1: trailing whitespace.` then `+beta`, exit 1; the committed tree prints
//                    `git_diff_check_passed`, exit 0 (tools/check-diff.mjs)
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["diff", "--check", "--no-ext-diff", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  process.stdout.write("git_diff_check_passed\n");
} catch (error) {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  process.stderr.write(output || "git_diff_check_failed\n");
  process.exitCode = 1;
}
