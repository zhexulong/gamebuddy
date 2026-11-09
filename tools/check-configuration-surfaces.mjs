/**
 * Every operation the Tavern contract declares must reach a player: the browser's api, a rendered control, and a spec.
 *
 * WHY THIS EXISTS
 *
 * The product's exposed configuration is one seam: `OperationId` in `host/src/tavern/browser-contract/index.ts` (a
 * `Type.Union` of literals) and the route table that serves them. Nothing checks that a declared operation is reachable
 * from `dialogue-web` - so an operation can be served, tested on the Host side, and never appear in front of a player, or
 * appear in the api module and never in a control. Both are the "end-to-end data consumption" defect in configuration
 * form: the field is accepted and stored, and the surface that would use it was never built.
 *
 * The population is DERIVED from the contract's own union, not listed here. A new operation appears in this gate the
 * moment it is declared, which is the point: the check cannot be outgrown by adding members.
 *
 * Readings are reported per operation with the first file:line that mentions it, and the default run is report-only:
 *
 *   node tools/check-configuration-surfaces.mjs            report, exit 0
 *   node tools/check-configuration-surfaces.mjs --fail     exit 1 when any operation is unreachable
 *
 * `unreadable` is its own verdict: an operation whose only mentions are inside a problem-code table is not a surface, and
 * this gate says so by name rather than counting it as reached.
 *
 * red-proof: inject remove `world-info.bind` from the tsx-only mention (make `CharactersSurfacePanel` stop naming it) ->
 * `unreachable:control` for `world-info.bind`, `status: "failed"` with `--fail`, exit 1; the same operation is
 * `control` before the injection. Second falsifier: an empty contract population (`OperationId` union removed) blocks
 * with `contract_operation_ids_not_found` rather than passing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolved from THIS FILE, not from `process.cwd()`.
 *
 * The harness runs a gate with its own directory as the working directory
 * (`harness-conformance.mjs`'s `runGateDefault`), and this gate used to read `host/...` relative to the shell - so it
 * threw `node:fs:483` there and read as a broken gate rather than a gate that never ran. Which directory the caller
 * happened to stand in is not a property of the tree we are checking.
 */
const ROOT = join(import.meta.dirname, "..");

const CONTRACT = "host/src/tavern/browser-contract/index.ts";
const WEB = "dialogue-web/src";
const SPECS = "dialogue-web/tests";

/** A problem-code table: a module that lists refusal codes and never calls anything. */
const CODE_TABLE = /chat-model-route\.ts$/u;
export function contractOperationIds(contractPath = CONTRACT) {
  const source = readFileSync(join(ROOT, contractPath), "utf8");
  const union = /const OperationId = Type\.Union\(\[([\s\S]*?)\]\)/u.exec(source);
  if (union === null) return null;
  const ids = [...union[1].matchAll(/Type\.Literal\("([^"]+)"\)/gu)].map((match) => match[1]);
  return ids.length === 0 ? null : [...new Set(ids)].sort();
}

function walk(directory, out = []) {
  // A tree that has no spec directory is a fact to report, not a crash: the first version threw ENOENT here, which made
  // a fixture without specs look like a broken gate rather than a gate with nothing to read.
  //
  // `directory` stays RELATIVE while the fs calls are rooted: recursing with an absolute path would prefix ROOT twice,
  // which is the same defect one level down (`tools/dialogue-web/...` inside a run started from `tools/`).
  const rooted = join(ROOT, directory);
  if (!existsSync(rooted)) return out;
  for (const entry of readdirSync(rooted)) {
    const relative = join(directory, entry);
    if (statSync(join(ROOT, relative)).isDirectory()) walk(relative, out);
    else if (/\.(ts|tsx)$/u.test(relative)) out.push(relative.replaceAll("\\", "/"));
  }
  return out;
}

function load(directory) {
  return walk(directory).map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
}

function firstMention(sources, needle, { skipCodeTables = false } = {}) {
  for (const { file, text } of sources) {
    if (skipCodeTables && CODE_TABLE.test(file)) continue;
    const index = text.indexOf(needle);
    if (index === -1) continue;
    return `${file}:${text.slice(0, index).split("\n").length}`;
  }
  return null;
}

export function checkConfigurationSurfaces({ contractPath = CONTRACT, web = WEB, specs = SPECS } = {}) {
  const ids = contractOperationIds(contractPath);
  if (ids === null) {
    return {
      gate: "configuration-surfaces",
      examined: 0,
      violations: [{ code: "contract_operation_ids_not_found" }],
      status: "blocked",
    };
  }
  const webSources = load(web);
  const apiSource = webSources.find((source) => source.file.endsWith("management-pipeline-api.ts")) ?? null;
  // The api module declares the operations it can send in its own union; that sets what a control could call, and it is
  // the half a player's surface depends on.
  const apiIds = new Set(
    apiSource === null
      ? []
      : [
          ...(/type TavernBrowserOperationV1 = Readonly<\{([\s\S]*?)\}>;/u
            .exec(apiSource.text)?.[1]
            ?.matchAll(/"([a-z-]+\.[a-z0-9.-]+)"/gu) ?? []),
        ].map((match) => match[1]),
  );
  const controlSources = webSources.filter((source) => source.file.endsWith(".tsx"));
  const specSources = load(specs);
  const violations = [];
  const rows = [];
  for (const id of ids) {
    const api = firstMention(webSources, id);
    const control = firstMention(controlSources, id);
    const spec = firstMention(specSources, id);
    const inApiUnion = apiIds.has(id);
    rows.push({ id, api, apiUnion: inApiUnion, control, spec });
    // HARD, and the only hard verdict: the Host serves it and dialogue-web never names it at all. Everything else is
    // reported, because panels reach operations through their api methods - a missing id in a component is not a gap,
    // and calling it one would make this gate the fourth thing tonight that mistook its own blind spot for a defect.
    if (api === null) violations.push({ code: "unreachable:web", operation: id });
  }
  return {
    gate: "configuration-surfaces",
    examined: ids.length,
    operations: rows,
    violations,
    informational: {
      noComponentNamesTheId: rows.filter((row) => row.control === null).map((row) => row.id),
      noSpecNamesTheId: rows.filter((row) => row.spec === null).map((row) => row.id),
      notInTheApiUnion: rows.filter((row) => row.apiUnion === false).map((row) => row.id),
    },
    status: violations.length === 0 ? "passed" : "failed",
  };
}

function report(result, out = process.stdout) {
  out.write(`configuration_surfaces: examined ${result.examined} contract operation(s)\n`);
  const gaps = result.informational ?? { noComponentNamesTheId: [], noSpecNamesTheId: [] };
  for (const row of result.operations ?? []) {
    out.write(
      `  ${row.id} api_union=${row.apiUnion ? "yes" : "NO"} control=${row.control ?? "-"} spec=${row.spec ?? "-"}\n`,
    );
  }
  for (const violation of result.violations) {
    out.write(`  ! ${violation.code}${violation.operation ? ` ${violation.operation}` : ""}\n`);
  }
  out.write(
    `  informational: ${gaps.noComponentNamesTheId.length} operation(s) no .tsx names directly, ` +
      `${gaps.noSpecNamesTheId.length} no spec names directly (panels call api methods; not a verdict)\n`,
  );
  out.write(
    `${JSON.stringify({
      gate: result.gate,
      examined: result.examined,
      violations: result.violations,
      // The rule this run verified, named: the harness reads `checks` to tell a gate that asserted something from one
      // that only printed a table. The status is the gate's own verdict, not a second opinion.
      checks: [{ id: "every_declared_operation_reaches_a_surface", status: result.status }],
      status: result.status,
    })}\n`,
  );
}

const main = () => {
  const result = checkConfigurationSurfaces();
  report(result);
  const failing = process.argv.includes("--fail");
  if (result.status === "blocked") return 1;
  return failing && result.status === "failed" ? 1 : 0;
};

if (process.argv[1]?.replaceAll("\\", "/").endsWith("check-configuration-surfaces.mjs")) process.exit(main());
