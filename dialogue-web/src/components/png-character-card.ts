/**
 * Browser-side PNG character-card reader.
 *
 * A SillyTavern PNG card carries its JSON in a `tEXt` / `zTXt` / `iTXt` chunk
 * whose keyword is `chara`, `ccv3` or `character`. The Host's stage route
 * (`POST /api/tavern/v1/imports`) accepts JSON *text* only and its decoder
 * classifies PNG by signature bytes, but the wire body is a string - so a PNG
 * cannot be posted as a PNG. The player chose the file in their own browser, so
 * this reads the embedded JSON locally and posts that text. Nothing leaves the
 * machine except the card JSON the Host would otherwise have received.
 *
 * The embedded JSON is deliberately NOT validated here: the Host's own decoder
 * remains the only authority on what a card is. This file only finds the chunk
 * and returns its text (or `undefined` when there is none).
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CHUNKS = 1024;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  }
  return true;
}

export async function extractCharacterCardJsonFromPng(bytes: Uint8Array): Promise<string | undefined> {
  if (!isPngBytes(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  for (let count = 0; offset + 12 <= bytes.length && count < MAX_CHUNKS; count += 1) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    if (length > bytes.length || dataStart + length + 4 > bytes.length) return undefined;
    const chunk = bytes.subarray(dataStart, dataStart + length);
    offset = dataStart + length + 4;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const text = await decodeTextChunk(type, chunk);
      if (text !== undefined) {
        const keyword = text.keyword.toLowerCase();
        if (keyword === "chara" || keyword === "ccv3" || keyword === "character")
          return decodeCharaValue(text.value);
      }
    }
    if (type === "IEND") break;
  }
  return undefined;
}

async function decodeTextChunk(
  type: "tEXt" | "zTXt" | "iTXt",
  chunk: Uint8Array,
): Promise<Readonly<{ keyword: string; value: string }> | undefined> {
  const first = chunk.indexOf(0);
  if (first < 1) return undefined;
  const keyword = ascii(chunk, 0, first);
  if (type === "tEXt") return { keyword, value: decodeUtf8(chunk.subarray(first + 1)) ?? "" };
  if (type === "zTXt") {
    if (first + 2 > chunk.length || chunk[first + 1] !== 0) return undefined;
    const inflated = await inflate(chunk.subarray(first + 2));
    return inflated === undefined ? undefined : { keyword, value: decodeUtf8(inflated) ?? "" };
  }
  // iTXt: keyword \0 compressionFlag compressionMethod language \0 translated \0 text
  if (first + 3 > chunk.length) return undefined;
  const compressed = chunk[first + 1] === 1;
  if (chunk[first + 2] !== 0) return undefined;
  let cursor = first + 3;
  for (let field = 0; field < 2; field += 1) {
    const end = chunk.indexOf(0, cursor);
    if (end < cursor) return undefined;
    cursor = end + 1;
  }
  const payload = compressed ? await inflate(chunk.subarray(cursor)) : chunk.subarray(cursor);
  return payload === undefined ? undefined : { keyword, value: decodeUtf8(payload) ?? "" };
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof DecompressionStream === "undefined" || bytes.length === 0) return undefined;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_INFLATED_BYTES) {
        await reader.cancel();
        return undefined;
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  } catch {
    return undefined;
  }
}

function decodeCharaValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const cleaned = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(cleaned) || cleaned.length % 4 !== 0) return undefined;
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return decodeUtf8(bytes);
  } catch {
    return undefined;
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]!);
  }
  return out;
}
