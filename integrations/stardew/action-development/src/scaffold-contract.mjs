import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOD_DIRECTORY_NAME = "integrations/stardew";
const MOD_COMPILE_EXCLUDED_PATHS = Object.freeze([
  "tests",
  "src/Core",
  "bin",
  "obj",
  "action-development",
]);
const CORE_COMPILE_EXCLUDED_PATHS = Object.freeze(["bin", "obj"]);
const ALLOWED_MOD_COMPILE_REMOVES = Object.freeze([
  "tests/**/*.cs",
  "src/Core/**/*.cs",
  "action-development/**/*.cs",
]);
const XML_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const ALLOWED_GAME1_WARP_SURFACE = Object.freeze([
  'PortfolioMineEntryGivenFixture.cs:Game1.warpFarmer("Mine",23,8,false)',
  'PortfolioMineElevatorGivenFixture.cs:Game1.warpFarmer("UndergroundMine5",6,6,2)',
  'PortfolioMineLadderGivenFixture.cs:Game1.warpFarmer("UndergroundMine2",6,6,2)',
]);

function fail(message) {
  throw new Error(message);
}

function isExcluded(relativePath, exclusions) {
  return exclusions.some(
    (excludedPath) => relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`),
  );
}

async function readRequiredFile(file, description) {
  try {
    return await readFile(file, "utf8");
  } catch {
    fail(`Required Stardew scaffold file is missing: ${description ?? file}`);
  }
}

async function collectCSharpFiles(directory, exclusions, relativeDirectory = "") {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail(`Stardew scaffold source closure is unreadable: ${directory}`);
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (isExcluded(relativePath, exclusions)) continue;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectCSharpFiles(absolutePath, exclusions, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".cs")) {
      files.push(absolutePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function normalizedRelativePath(file, root) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function projectModelFailure(projectDescription, detail) {
  fail(`${projectDescription} project compile model is unsupported: ${detail}`);
}

function findXmlMarkupEnd(source, openingIndex, projectDescription) {
  let quote = null;
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "<") {
        projectModelFailure(projectDescription, "a '<' appears inside a quoted XML attribute");
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "<") {
      projectModelFailure(projectDescription, "an XML tag contains a nested '<'");
    } else if (character === ">") {
      return index;
    }
  }
  projectModelFailure(projectDescription, "an XML tag is not closed");
}

function parseXmlAttributes(body, projectDescription) {
  const attributes = new Map();
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index])) index += 1;
    if (index === body.length) break;

    const nameMatch = body.slice(index).match(XML_NAME_PATTERN);
    if (!nameMatch) {
      projectModelFailure(projectDescription, "an XML attribute is malformed");
    }
    const name = nameMatch[0];
    index += name.length;
    while (index < body.length && /\s/.test(body[index])) index += 1;
    if (body[index] !== "=") {
      projectModelFailure(projectDescription, `XML attribute '${name}' has no value`);
    }
    index += 1;
    while (index < body.length && /\s/.test(body[index])) index += 1;
    const quote = body[index];
    if (quote !== '"' && quote !== "'") {
      projectModelFailure(projectDescription, `XML attribute '${name}' is not quoted`);
    }
    index += 1;
    const valueStart = index;
    while (index < body.length && body[index] !== quote) index += 1;
    if (index === body.length) {
      projectModelFailure(projectDescription, `XML attribute '${name}' is not closed`);
    }
    if ([...attributes.keys()].some((existingName) => existingName.toLowerCase() === name.toLowerCase())) {
      projectModelFailure(projectDescription, `XML attribute '${name}' is duplicated`);
    }
    attributes.set(name, body.slice(valueStart, index));
    index += 1;
  }
  return attributes;
}

function parseXmlStartTag(source, openingIndex, closingIndex, projectDescription) {
  let body = source.slice(openingIndex + 1, closingIndex).trim();
  let selfClosing = false;
  if (body.endsWith("/")) {
    selfClosing = true;
    body = body.slice(0, -1).trim();
  }
  const nameMatch = body.match(XML_NAME_PATTERN);
  if (!nameMatch) {
    projectModelFailure(projectDescription, "an XML start tag has no valid name");
  }
  const name = nameMatch[0];
  const attributes = parseXmlAttributes(body.slice(name.length), projectDescription);
  return { name, attributes, selfClosing };
}

function parseXmlClosingTag(source, openingIndex, closingIndex, projectDescription) {
  const body = source.slice(openingIndex + 2, closingIndex).trim();
  const nameMatch = body.match(XML_NAME_PATTERN);
  if (!nameMatch || nameMatch[0].length !== body.length) {
    projectModelFailure(projectDescription, "an XML closing tag is malformed");
  }
  return nameMatch[0];
}

function normalizedCompileRemove(value) {
  return value.replaceAll("\\", "/").replace(/\s+/g, "");
}

function validateCompileDirective({ name, attributes, selfClosing }, projectDescription, projectKind) {
  if (name.toLowerCase() === "enabledefaultcompileitems") {
    projectModelFailure(projectDescription, "declares EnableDefaultCompileItems; the default SDK compile topology must remain implicit");
  }
  if (name.toLowerCase() !== "compile") return;

  const normalizedAttributes = new Map(
    [...attributes].map(([attributeName, value]) => [attributeName.toLowerCase(), value]),
  );
  if (normalizedAttributes.has("include")) {
    projectModelFailure(projectDescription, "uses unsupported <Compile Include=...>; linked or explicit compile items are outside the default topology");
  }
  if (normalizedAttributes.has("update")) {
    projectModelFailure(projectDescription, "uses unsupported <Compile Update=...>; item updates are outside the default topology");
  }
  if (!normalizedAttributes.has("remove")) {
    projectModelFailure(projectDescription, "uses an unsupported <Compile> directive; only the established Mod source-boundary removes are allowed");
  }
  if (!selfClosing) {
    projectModelFailure(projectDescription, "uses a non-self-closing <Compile Remove=...> directive");
  }
  if (projectKind === "Core") {
    projectModelFailure(projectDescription, "uses unsupported <Compile Remove=...>; Core must rely entirely on default SDK compile items");
  }
  if (normalizedAttributes.size !== 1) {
    projectModelFailure(projectDescription, "uses a mixed <Compile Remove=...> directive with unsupported attributes");
  }

  const removeValue = normalizedAttributes.get("remove");
  const normalizedValue = normalizedCompileRemove(removeValue);
  if (!ALLOWED_MOD_COMPILE_REMOVES.includes(normalizedValue)) {
    projectModelFailure(projectDescription, `uses unsupported <Compile Remove=\"${removeValue}\" />`);
  }
}

function validateDefaultCompileProjectModel(source, projectDescription, projectKind) {
  if (typeof source !== "string" || source.trim() === "") {
    projectModelFailure(projectDescription, "project XML is empty");
  }

  const openElements = [];
  let rootName = null;
  let rootClosed = false;
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (index < source.length) {
    const openingIndex = source.indexOf("<", index);
    if (openingIndex === -1) {
      const trailingText = source.slice(index);
      if (openElements.length === 0 && trailingText.trim() !== "") {
        projectModelFailure(projectDescription, "non-whitespace text appears outside the project element");
      }
      break;
    }

    const text = source.slice(index, openingIndex);
    if (openElements.length === 0 && text.trim() !== "") {
      projectModelFailure(projectDescription, "non-whitespace text appears outside the project element");
    }

    if (source.startsWith("<!--", openingIndex)) {
      const commentEnd = source.indexOf("-->", openingIndex + 4);
      if (commentEnd === -1) {
        projectModelFailure(projectDescription, "an XML comment is not closed");
      }
      if (source.slice(openingIndex + 4, commentEnd).includes("--")) {
        projectModelFailure(projectDescription, "an XML comment contains an invalid '--' sequence");
      }
      index = commentEnd + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", openingIndex)) {
      if (openElements.length === 0) {
        projectModelFailure(projectDescription, "CDATA appears outside the project element");
      }
      const cdataEnd = source.indexOf("]]>", openingIndex + 9);
      if (cdataEnd === -1) {
        projectModelFailure(projectDescription, "a CDATA section is not closed");
      }
      index = cdataEnd + 3;
      continue;
    }
    if (source.startsWith("<?", openingIndex)) {
      const instructionEnd = source.indexOf("?>", openingIndex + 2);
      if (instructionEnd === -1) {
        projectModelFailure(projectDescription, "an XML processing instruction is not closed");
      }
      index = instructionEnd + 2;
      continue;
    }
    if (source[openingIndex + 1] === "!") {
      projectModelFailure(projectDescription, "an unsupported XML declaration is present");
    }

    const closingIndex = findXmlMarkupEnd(source, openingIndex, projectDescription);
    if (source[openingIndex + 1] === "/") {
      const name = parseXmlClosingTag(source, openingIndex, closingIndex, projectDescription);
      if (openElements.length === 0 || openElements.at(-1) !== name) {
        projectModelFailure(projectDescription, `XML closing tag '${name}' does not match its open element`);
      }
      openElements.pop();
      if (openElements.length === 0) rootClosed = true;
      index = closingIndex + 1;
      continue;
    }

    if (rootClosed) {
      projectModelFailure(projectDescription, "markup appears after the project element");
    }
    const tag = parseXmlStartTag(source, openingIndex, closingIndex, projectDescription);
    if (rootName === null) rootName = tag.name;
    if (openElements.length === 0 && rootName !== tag.name) {
      projectModelFailure(projectDescription, "multiple root elements are present");
    }
    validateCompileDirective(tag, projectDescription, projectKind);
    if (!tag.selfClosing) openElements.push(tag.name);
    else if (openElements.length === 0) rootClosed = true;
    index = closingIndex + 1;
  }

  if (openElements.length !== 0) {
    projectModelFailure(projectDescription, `XML element '${openElements.at(-1)}' is not closed`);
  }
  if (rootName !== "Project" || !rootClosed) {
    projectModelFailure(projectDescription, "the XML root must be a closed Project element");
  }
}

function normalizedSource(source) {
  return source.replace(/\s+/g, "");
}

function findClosingParenthesis(source, openingIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function normalizedWarpSurface(source, relativePath) {
  const calls = [];
  const callPattern = /\bGame1\s*\.\s*warpFarmer\s*\(/g;

  for (const match of source.matchAll(callPattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findClosingParenthesis(source, openingIndex);
    const callSource = closingIndex === -1
      ? source.slice(match.index)
      : source.slice(match.index, closingIndex + 1);
    calls.push(`${relativePath}:${normalizedSource(callSource)}`);
  }
  return calls;
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Validate the package-local static Stardew scaffold contract.
 *
 * The explicit root must contain the repository's integrations/stardew directory.
 * This checker validates the default SDK compile topology and reads source files;
 * it does not evaluate arbitrary MSBuild or invoke a build tool or another checker process.
 */
export async function verifyStardewScaffold(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    fail("An explicit Stardew project root is required.");
  }

  const resolvedProjectRoot = path.resolve(projectRoot);
  const modRoot = path.join(resolvedProjectRoot, MOD_DIRECTORY_NAME);
  const coreRoot = path.join(modRoot, "src", "Core");
  const executionControllerPath = path.join(modRoot, "farmhandexecutioncontroller.cs");
  const bridgeProtocolPath = path.join(coreRoot, "Protocol", "BridgeProtocol.cs");
  const executionController = await readRequiredFile(executionControllerPath, "farmhandexecutioncontroller.cs");
  await readRequiredFile(bridgeProtocolPath, "src/Core/Protocol/BridgeProtocol.cs");
  const modProjectPath = path.join(modRoot, "GameBuddy.Stardew.csproj");
  const coreProjectPath = path.join(coreRoot, "GameBuddy.Stardew.Core.csproj");
  const modProject = await readRequiredFile(modProjectPath, "GameBuddy.Stardew.csproj");
  const coreProject = await readRequiredFile(coreProjectPath, "src/Core/GameBuddy.Stardew.Core.csproj");
  validateDefaultCompileProjectModel(modProject, "Mod", "Mod");
  validateDefaultCompileProjectModel(coreProject, "Core", "Core");
  if (!/\bclass\s+ExecutionManager\b[^{};]*:\s*[^{};]*\bIExecutionLedger\b/.test(executionController)) {
    fail("farmhandexecutioncontroller.cs must declare ExecutionManager implementing IExecutionLedger");
  }

  const modCompilePaths = await collectCSharpFiles(modRoot, MOD_COMPILE_EXCLUDED_PATHS);
  const coreCompilePaths = await collectCSharpFiles(coreRoot, CORE_COMPILE_EXCLUDED_PATHS);
  const sourceEntries = await Promise.all(
    [...modCompilePaths, ...coreCompilePaths].map(async (file) => [file, await readFile(file, "utf8")]),
  );
  const sourceByPath = new Map(sourceEntries);

  const actualGame1WarpSurface = modCompilePaths.flatMap((file) =>
    normalizedWarpSurface(sourceByPath.get(file), normalizedRelativePath(file, modRoot)),
  ).sort();
  const expectedGame1WarpSurface = [...ALLOWED_GAME1_WARP_SURFACE].sort();
  if (!sameStringArray(actualGame1WarpSurface, expectedGame1WarpSurface)) {
    fail("Stardew scaffold has unexpected Game1-level target-runtime fixture warp surface.");
  }

  return Object.freeze({
    schema: "gamebuddy-stardew-scaffold-contract/v1",
    status: "passed",
    modCompileFileCount: modCompilePaths.length,
    coreCompileFileCount: coreCompilePaths.length,
  });
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || arguments_[0].trim() === "") {
    process.stderr.write("stardew_action_scaffold_contract_project_root_required\n");
    process.exitCode = 1;
  } else {
    verifyStardewScaffold(arguments_[0]).then(
      (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
      (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
    );
  }
}
