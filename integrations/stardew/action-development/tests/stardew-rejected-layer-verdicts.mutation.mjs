/**
 * Decisive mutation checks for the rejected-layer rules.
 *
 * Each mutation removes one of the three rules and the suite must go RED. A rule whose
 * removal leaves the suite green is not enforced, only documented.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const MODULE = "integrations/stardew/action-development/src/analysis/stardew-action-inventory-reconciliation.mjs";
const TEST = "integrations/stardew/action-development/tests/stardew-rejected-layer-verdicts.test.mjs";
const original = fs.readFileSync(MODULE, "utf8");

const MUTATIONS = [
  {
    label: "R1 member-name fallback (hides the Grass-class collision)",
    from: "  const owners = seamMembers.byFileMember.get(`${base}\\u0000${member}`);\n  return owners ? [...owners] : [];",
    to: "  const scoped = seamMembers.byFileMember.get(`${base}\\u0000${member}`);\n  const owners = scoped ?? seamMembers.byMember.get(member);\n  return owners ? [...owners] : [];",
  },
  {
    label: "R2 skip the seam join entirely (covered units look like gaps)",
    from: "    const ownHit = seamMembers ? ownersForUnit(seamMembers, u.file, u.member) : [];",
    to: "    const ownHit = [];",
  },
  {
    label: "R3 accept a unit with no verdict",
    from: "      if (!verdict) throw new Error(`rejected_unit_without_verdict:${key}`);",
    to: "      if (!verdict) { used.add(key); group = \"needs_adjudication\"; reason = \"unadjudicated\"; return { key, kind: \"rejected_unit\", className: u.className, member: u.member, file: u.file, line: u.line, rejectedBy: [], ownEffects: [], chainGameplayEffects: [], resolveChain: [], group, actionIds: [], boundary: null, reason, anchor: null }; }",
  },
  {
    label: "R4 drop the unused-verdict completeness check",
    from: "  const unused = Object.keys(verdicts).filter((k) => !used.has(k));\n  if (unused.length) throw new Error(`rejected_layer_verdict_not_matched_to_any_unit:${unused.sort().join(\",\")}`);",
    to: "  const unused = [];",
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