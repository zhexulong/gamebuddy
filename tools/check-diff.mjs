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
