const { readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

/**
 * The dialogue-web layering, read off the tree instead of listed here.
 *
 * `.dependency-cruiser.dialogue-web.cjs` turns these zones into the boundary rules and
 * `tools/check-dialogue-web-boundaries.test.mjs` measures them, so the patterns the
 * cruiser enforces and the population the gate reports are one fact with one spelling.
 *
 * Every zone comes from something the product already owns:
 *
 *   assembler  the one app module `main.tsx` mounts. The browser entry is this
 *              frontend's own declaration of what composes the product.
 *   surface    `components/<Name>Surface.tsx` - the filename convention the peer
 *              surfaces already follow, so a new surface is a surface the moment it is
 *              added, and no module but the assembler may import it.
 *   contract   declared by the module itself, on its first line:
 *              `// @zone contract:chat` or `// @zone contract:platform`. "This module IS
 *              the wire boundary" is a role no path and no import can express, so the
 *              module states it - and the statement cannot outlive the file, where an
 *              entry in a central list outlives the module it named and has to be
 *              remembered for the module that does not exist yet.
 *   module     everything else, by subtraction: the residual is a zone rather than an
 *              omission, so a new file inherits the rules that hold for every module
 *              instead of landing outside all of them.
 *
 * The revision before this one held a hand-written list of path patterns instead. It
 * covered 48 of the tree's 78 modules, so 30 modules carried no boundary rule at all,
 * and the gate that measured it failed on the first of them and could say nothing about
 * the other 29.
 */
const SRC = "dialogue-web/src";
const ENTRY = "main.tsx";

/** The declaration a module makes about itself, on its first line. */
const CONTRACT_DECLARATION = /^\/\/ @zone contract:(chat|platform)$/;
const CONTRACT_FLAVOURS = ["chat", "platform"];

const sourceRoot = path.join(__dirname, "dialogue-web", "src");

const sourceOf = (relativePath) => readFileSync(path.join(sourceRoot, relativePath), "utf8");

const escapePattern = (relativePath) => relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a module says about itself, or undefined when it says nothing. */
function declaredContract(relativePath) {
  const firstLine = sourceOf(relativePath).split(/\r?\n/, 1)[0].trim();
  return CONTRACT_DECLARATION.exec(firstLine)?.[1];
}

/** The module the browser entry mounts, named with the extension the file actually has. */
function mountedModule() {
  const specifiers = [...sourceOf(ENTRY).matchAll(/(?:from\s+|import\s+)["'](\.\/[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.endsWith(".css"));
  const mounted = specifiers.map((specifier) =>
    [specifier.slice(2), `${specifier.slice(2)}.tsx`, `${specifier.slice(2)}.ts`].find((candidate) => {
      try {
        return statSync(path.join(sourceRoot, candidate)).isFile();
      } catch {
        return false;
      }
    }),
  );
  if (mounted.length !== 1 || mounted[0] === undefined)
    throw new Error(
      `${SRC}/${ENTRY} must mount exactly one app module and no more: it names ${JSON.stringify(specifiers)}, and the assembler zone is derived from that one module`,
    );
  return mounted[0];
}

/** Every `.ts`/`.tsx` module under `dialogue-web/src`, relative to it. */
function sourceModules() {
  const modules = [];
  const walk = (relativeDir) => {
    for (const entry of readdirSync(path.join(sourceRoot, relativeDir), { withFileTypes: true })) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walk(relativePath);
      else if (/\.tsx?$/.test(entry.name)) modules.push(relativePath);
    }
  };
  walk("");
  return modules;
}

/** The wire contracts, read off the modules that declare the role. */
function declaredContracts() {
  const contracts = Object.fromEntries(CONTRACT_FLAVOURS.map((flavour) => [flavour, []]));
  for (const module of sourceModules()) {
    const flavour = declaredContract(module);
    if (flavour !== undefined) contracts[flavour].push(module);
  }
  for (const flavour of CONTRACT_FLAVOURS)
    if (contracts[flavour].length === 0)
      throw new Error(
        `no module declares a ${flavour} wire contract: the contract zone is read from the declarations, so an empty one is a blocked reading rather than a gate that agrees with itself`,
      );
  return contracts;
}

const ASSEMBLER = mountedModule();
const CONTRACTS = declaredContracts();

/** Zone name -> the regular expression that selects it, in dependency-cruiser's repo-relative form. */
const ZONES = {
  assembler: `^${SRC}/${escapePattern(ASSEMBLER)}$`,
  surface: `^${SRC}/components/[^/]*Surface\\.tsx$`,
  chatContract: `^${SRC}/(${CONTRACTS.chat.map(escapePattern).join("|")})$`,
  platformContract: `^${SRC}/(${CONTRACTS.platform.map(escapePattern).join("|")})$`,
  components: `^${SRC}/components/`,
  module: `^${SRC}/`,
};

module.exports = {
  SRC,
  ZONES,
  assembler: ASSEMBLER,
  contracts: CONTRACTS,
  sourceModules,
};
