function fail(code) {
  throw new Error(`stardew_action_json_${code}`);
}

function whitespace(text, index) {
  while (/\s/.test(text[index] ?? "")) index++;
  return index;
}

function stringEnd(text, index) {
  if (text[index] !== '"') fail("invalid_json");
  const start = index++;
  let escaped = false;
  while (index < text.length) {
    const character = text[index++];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') {
      try { return { value: JSON.parse(text.slice(start, index)), index }; } catch { fail("invalid_json"); }
    }
  }
  fail("invalid_json");
}

function valueEnd(text, index) {
  index = whitespace(text, index);
  if (text[index] === '"') return stringEnd(text, index).index;
  if (text[index] === "{") {
    const keys = new Set();
    index = whitespace(text, index + 1);
    if (text[index] === "}") return index + 1;
    while (true) {
      const key = stringEnd(text, index);
      if (keys.has(key.value)) fail("duplicate_key");
      keys.add(key.value);
      index = whitespace(text, key.index);
      if (text[index] !== ":") fail("invalid_json");
      index = valueEnd(text, index + 1);
      index = whitespace(text, index);
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",") fail("invalid_json");
      index = whitespace(text, index + 1);
    }
  }
  if (text[index] === "[") {
    index = whitespace(text, index + 1);
    if (text[index] === "]") return index + 1;
    while (true) {
      index = valueEnd(text, index);
      index = whitespace(text, index);
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",") fail("invalid_json");
      index = whitespace(text, index + 1);
    }
  }
  const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
  if (!literal) fail("invalid_json");
  return index + literal[0].length;
}

export function parseJsonWithoutDuplicateKeys(text, errorPrefix) {
  if (typeof text !== "string") throw new Error(`${errorPrefix}_invalid_size`);
  try {
    const end = valueEnd(text, 0);
    if (whitespace(text, end) !== text.length) fail("invalid_json");
    return JSON.parse(text);
  } catch (error) {
    const code = error instanceof Error && error.message === "stardew_action_json_duplicate_key" ? "duplicate_key" : "invalid_json";
    throw new Error(`${errorPrefix}_${code}`);
  }
}
