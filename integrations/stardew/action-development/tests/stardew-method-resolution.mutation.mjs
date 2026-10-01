/**
 * Decisive mutation checks for `stardew-method-resolution`.
 *
 * The tests assert facts about the target source; these checks prove the tests would
 * FAIL if the mechanism behind those facts were removed. A test that stays green under
 * a real mutation is not testing the mechanism -- the first run of this script exposed
 * exactly that (`STILL GREEN` on M3), which is why the presentation predicate is now a
 * single authority instead of three copies.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const MODULE = "integrations/stardew/action-development/src/analysis/stardew-method-resolution.mjs";
const TEST = "integrations/stardew/action-development/tests/stardew-method-resolution.test.mjs";
const original = fs.readFileSync(MODULE, "utf8");

const MUTATIONS = [
  { label: "M1 stop following the delegation chain", from: "    for (let d = 0; d < bounded && frontier.length; d += 1) {", to: "    for (let d = 0; d < 0 && frontier.length; d += 1) {" },
  { label: "M2 count a delegated call as the entry's own effect", from: '    const ownEffects = classifyRaw(ownStatements(ownBody, isHelperCall).join("; "));', to: "    const ownEffects = classifyRaw(ownBody);" },
  { label: "M3 treat presentation as gameplay", from: 'const PRESENTATION_ONLY = new Set(["presentation"]);', to: "const PRESENTATION_ONLY = new Set([]);" },
  { label: "M4 chain always claims gameplay", from: "      chainReachesGameplay: chainGameplay.length > 0 && ownGameplay.length === 0,", to: "      chainReachesGameplay: true," },
  {
    label: "M5 revert to regex call extraction",
    from: `function invocationTexts(src, node) {
  const out = new Set();
  for (const call of collect(node, "invocation_expression")) {
    const fn = call.childForFieldName("function");
    if (fn) out.add(src.slice(fn.startIndex, fn.endIndex).replace(/\\s+/g, " "));
  }
  return [...out];
}`,
    to: `function invocationTexts(src, node) {
  const body = src.slice(node.startIndex, node.endIndex);
  const out = new Set();
  for (const m of body.matchAll(/[A-Za-z_]\\w*\\s*\\(/g)) out.add(m[0].replace(/\\s*\\($/, ""));
  return [...out];
}`,
  },
];

const run = () => {
  try {
    execFileSync("node", ["--test", TEST], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
    return { failed: false, out: "" };
  } catch (error) {
    return { failed: true, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

let allCaught = true;
for (const m of MUTATIONS) {
  if (!original.includes(m.from)) {
    console.log(`ANCHOR-MISSING   ${m.label}`);
    allCaught = false;
    continue;
  }
  fs.writeFileSync(MODULE, original.replace(m.from, m.to));
  const r = run();
  const failing = (r.out.match(/✖ /g) ?? []).length;
  if (!r.failed) allCaught = false;
  console.log(`${r.failed ? `CAUGHT (${failing} failing)` : "STILL GREEN"}`.padEnd(22) + m.label);
  fs.writeFileSync(MODULE, original);
}

const final = run();
console.log(`\nrestored -> ${final.failed ? "RED (BAD)" : "GREEN (ok)"}`);
console.log(allCaught ? "all mutations caught" : "SOME MUTATIONS NOT CAUGHT");
process.exitCode = allCaught && !final.failed ? 0 : 1;