/**
 * The ONE resolver for a citation of C# source: `<file>.cs:<symbol>` -> the declaration that symbol names.
 *
 * WHY A SYMBOL AND NOT A LINE RANGE. `cropTargets.publishedAsWork` cited `farmhandtargetdiscovery.cs` by a line range, that
 * file grew from 1,743 to 2,843 lines, and the reason text did not change a word while `DiscoverCropTargets` moved out of
 * the range: the citation kept its shape and lost its subject. A symbol is looked up wherever it went, so the same reason
 * either finds its declaration or fails by name.
 *
 * WHAT THIS MODULE OWNS, and why every citation-bearing gate must come through it: the spelling of a citation, the rule
 * that decides whether a cited file is this repository's own source, and the declaration test. A second gate that
 * restated any of the three would be a second answer to the same question - the defect this repository keeps paying for -
 * so the pieces are exported here once and the gates pass their own file lists in.
 *
 * PURE OVER ITS INPUTS. No file is read in this module: the gate that owns the reading decides what a "file" is (a
 * tracked path, a walk of the tree, a fixture in a falsifier) and hands over text. That is what lets a suite drive the
 * same resolver over a source set this repository does not have.
 */

/**
 * A citation of a LINE RANGE: `<file>.cs:<from>-<to>`.
 *
 * The spelling the round99 defect had. A range is not a citation because nothing in the tree re-reads it: the file grows,
 * the range stays where it was written, and a claim whose subject moved out of it still reads as anchored.
 */
export const RANGE_CITATION = /([A-Za-z][A-Za-z0-9_.]*)\.cs:(\d+)-(\d+)/gu;

/**
 * A citation of a SYMBOL: `<file>.cs:<symbol>`. The one spelling a claim about the Mod's code may take.
 *
 * The symbol is read case-sensitively and must start a C# identifier, so `file.cs:123` (a line) and `file.cs:1-2` (a
 * range) cannot be mistaken for one.
 */
export const SYMBOL_CITATION = /([A-Za-z][A-Za-z0-9_.]*)\.cs:([A-Za-z_][A-Za-z0-9_]*)/gu;

/**
 * A citation of ONE line: `<file>.cs:<line>`. Not this module's population, and stated rather than hidden.
 *
 * `gates/stardew/check-stardew-invented-gates.mjs` reads a cited line to recover a NUMBER (`engineReadingAt`: the radius
 * a native call is given), which a symbol cannot carry, so a single line is kept for that reading. A single line expires
 * exactly as silently as a range does - the count is printed by `gates/stardew/check-stardew-source-citations.mjs` so the
 * hole stays visible instead of being counted as handled.
 */
export const SINGLE_LINE_CITATION = /([A-Za-z][A-Za-z0-9_.]*)\.cs:(\d+)(?![\d-])/gu;

/**
 * Whether `names` declares `citedFile`, where `names` is a set of lower-cased `.cs` file names.
 *
 * The Mod's partials are cited by their tail (`resourcetoolactions.cs` for
 * `farmhandexecutioncontroller.resourcetoolactions.cs`), which is how this tree has always written them, so a cited name
 * matches a declared file that ends with `.` + the cited name. Exact matches win nothing over suffixed ones: a citation
 * names a file, and the tail identifies it.
 */
export function namesFile(names, citedFile) {
  if (names === null) return false;
  const name = citedFile.toLowerCase();
  if (names.has(name)) return true;
  for (const declared of names) if (declared.endsWith(`.${name}`)) return true;
  return false;
}

/** The lower-cased `.cs` file names of `paths`: what a citation can resolve against, derived from any file list. */
export function sourceNames(paths) {
  const names = new Set();
  for (const path of paths) {
    const normalized = String(path).replace(/\\/gu, "/");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (name.endsWith(".cs")) names.add(name.toLowerCase());
  }
  return names;
}

/**
 * Where `symbol` is DECLARED in `source`, or `null` when this text declares no such member.
 *
 * A MENTION IS NOT A DECLARATION - `DiscoveryExclusionReasons.AlreadyWatered` and `ExecutionManager.CropNeedsWater` are
 * named inside the same file without either being declared there, so the name alone would anchor a claim to a call site.
 * The rule is a line whose access modifier and return type are followed by the name and its parameter list, which is the
 * shape this Mod is written in, and it is the whole reason a call site cannot impersonate its own declaration.
 *
 * WHAT IT DOES NOT ACCEPT: a member with no parameter list - a property, a constant, an enum member - reads as
 * undeclared. That is the shape a citation of the Mod's publication predicates asks for, and a caller that wants fields
 * as well has to say so here rather than grow a second rule beside it.
 */
export function resolveSymbol(source, symbol) {
  const lines = typeof source === "string" ? source.split("\n") : source;
  const declaration = new RegExp(`\\b(?:public|private|protected|internal)\\s[^;{}=]*\\b${escape(symbol)}\\s*\\(`, "u");
  for (const [index, line] of lines.entries()) {
    if (declaration.test(line)) return { line: index + 1, text: line.trim() };
  }
  return null;
}

/** Whether `source` declares `symbol` - `resolveSymbol` asked as a question, for a caller that wants no line. */
export function declaresSymbol(source, symbol) {
  return resolveSymbol(source, symbol) !== null;
}

/**
 * What a symbol citation found in the file it names, in two tiers - and the tier is the reading, not a detail.
 *
 * A DECLARATION is the rule above: the file declares the member. A MENTION is the identifier appearing in the file at
 * all, which is what a citation of a FIXTURE means - `check-stardew-lifecycle-pins.mjs` cites
 * `OpenGeodeWireContractTests.cs:open_geode`, and that file's own text names the action id without declaring a member
 * called `open_geode`, because the citation is about the literal a test pins rather than about a member of the Mod.
 * Reading the two as one answer would either refuse every fixture citation or accept a call site as a declaration.
 *
 * `null` is the only failing answer: the file does not carry the name at all, so a rename or a wrong name is red either
 * way, and the tier says how much the citation actually anchored.
 */
export function resolveCitation(source, symbol) {
  const lines = typeof source === "string" ? source.split("\n") : source;
  const declaration = resolveSymbol(lines, symbol);
  if (declaration !== null) return { tier: "declaration", ...declaration };
  const mention = new RegExp(`\\b${escape(symbol)}\\b`, "u");
  for (const [index, line] of lines.entries())
    if (mention.test(line)) return { tier: "mention", line: index + 1, text: line.trim() };
  return null;
}

const ESCAPE = /[.*+?^${}()|[\]\\]/gu;
const escape = (text) => text.replace(ESCAPE, "\\$&");
