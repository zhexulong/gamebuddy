/**
 * Extract literal operation selectors from decompiled method bodies.
 *
 * This is intentionally syntactic: a selector is a discovered game operation
 * that still requires semantic expansion, never an action grant. Switch case
 * labels are retained as source-derived branch selectors. Equality literals are
 * retained only when the compared variable looks like a dispatch key; item
 * IDs and ordinary state comparisons are not promoted to operation nodes.
 */

const DISPATCH_KEY_NAMES = Object.freeze({
  performAction: new Set(["action", "actionType", "fullActionString", "key", "text", "value", "value2"]),
  answerDialogue: new Set(["key", "question", "questionKey", "questionAndAnswer"]),
  answerDialogueAction: new Set(["key", "question", "questionKey", "questionAndAnswer"]),
  checkAction: new Set(["action", "actionType", "eventAction", "question", "questionKey"]),
});

function dispatchKeyNames(methodName) {
  return DISPATCH_KEY_NAMES[methodName] ?? new Set();
}

function isOperationLiteral(value) {
  return value !== "..."
    && value.length <= 160
    && !/^\([A-Z]\)/.test(value)
    && !/^-?\d{4,}$/.test(value);
}

export function extractLiteralOperationSelectors(source, methodName) {
  const selectors = new Map();
  const declaration = new RegExp(String.raw`\b${methodName}\s*\([^;{}]*\)\s*\{`, "g");
  const keyNames = dispatchKeyNames(methodName);

  function add(selector, selectorKind, variableName = null) {
    if (!isOperationLiteral(selector)) return;
    const key = `${selectorKind}:${variableName ?? ""}:${selector}`;
    if (!selectors.has(key)) selectors.set(key, { selector, selectorKind, ...(variableName ? { selectorVariable: variableName } : {}) });
  }

  function bodyAfter(openBrace) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openBrace; index < source.length; index += 1) {
      const character = source[index];
      const next = source[index + 1];
      if (lineComment) {
        if (character === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}" && --depth === 0) return source.slice(openBrace + 1, index);
    }
    return "";
  }

  function withoutComments(value) {
    let output = "";
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      const next = value[index + 1];
      if (lineComment) {
        if (character === "\n") {
          lineComment = false;
          output += character;
        } else {
          output += " ";
        }
        continue;
      }
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          output += "  ";
          index += 1;
        } else {
          output += character === "\n" ? "\n" : " ";
        }
        continue;
      }
      if (quote) {
        output += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "/" && next === "/") {
        lineComment = true;
        output += "  ";
        index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        output += "  ";
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      output += character;
    }
    return output;
  }

  for (const declarationMatch of source.matchAll(declaration)) {
    const body = withoutComments(bodyAfter(declarationMatch.index + declarationMatch[0].length - 1));
    for (const match of body.matchAll(/\bcase\s+"([^"\r\n]+)"\s*:/g)) add(match[1], "case");
    if (keyNames.size > 0) {
      for (const match of body.matchAll(/\b([A-Za-z_]\w*(?:\s*\[[^\]\r\n]+\])*)\s*(?:==|!=)\s*"([^"\r\n]+)"/g)) {
        const variable = match[1].replace(/\s+/g, "");
        if (keyNames.has(variable.split("[")[0])) add(match[2], "comparison", variable);
      }
      for (const match of body.matchAll(/"([^"\r\n]+)"\s*(?:==|!=)\s*\b([A-Za-z_]\w*(?:\s*\[[^\]\r\n]+\])*)/g)) {
        const variable = match[2].replace(/\s+/g, "");
        if (keyNames.has(variable.split("[")[0])) add(match[1], "comparison", variable);
      }
      for (const match of body.matchAll(/\b([A-Za-z_]\w*(?:\s*\[[^\]\r\n]+\])*)\.Equals\s*\(\s*"([^"\r\n]+)"\s*\)/g)) {
        const variable = match[1].replace(/\s+/g, "");
        if (keyNames.has(variable.split("[")[0])) add(match[2], "method", variable);
      }
    }
  }

  return [...selectors.values()].sort((left, right) =>
    left.selector.localeCompare(right.selector)
      || left.selectorKind.localeCompare(right.selectorKind)
      || (left.selectorVariable ?? "").localeCompare(right.selectorVariable ?? ""));
}
