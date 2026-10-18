import { isCompletePngFile } from "./companion-avatar/index.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./compatibility-manifest.v1.js";

/**
 * A companion's card as a PNG: her own picture, with her card inside it.
 *
 * This is a container writer, not an image editor. It never looks at a pixel:
 * the picture is the PNG it was handed, kept chunk for chunk, and the only bytes
 * it adds are the one `tEXt` chunk that carries the card. A PNG character card -
 * the form players actually trade - is a picture and a card in one file, and the
 * SillyTavern ecosystem reads the card out of the `tEXt` chunk whose keyword is
 * `chara`.
 *
 * **The card is base64, because that is the ecosystem's spelling.** Every writer
 * that produces a PNG card base64-encodes the card JSON into `chara`, and every
 * reader accepts it - our decoder's own `decodeCharaValue` (`st-card-import.ts`)
 * base64-decodes a value that is not already JSON. Base64 is ASCII, so the chunk
 * is framed in Latin-1 with no encoding question.
 *
 * **A picture's own card chunks are dropped.** A companion's picture IS the card
 * file she was imported from, so her bytes may already carry a `chara` chunk: the
 * card she came from. Our decoder returns the FIRST card-keyed chunk it meets, so
 * leaving that stale one where it lies would make every export re-import as her
 * ORIGINAL card and silently discard everything the player has changed since. The
 * writer therefore drops every `tEXt`/`zTXt`/`iTXt` chunk whose keyword is a card
 * keyword (`chara`, `ccv3`, `character`) and writes its own `chara` chunk directly
 * after `IHDR`, where no earlier card chunk can shadow it. Non-card metadata (a
 * `tEXt` comment, a `gAMA`, a `PLTE`, the `IDAT` itself) is kept byte for byte.
 *
 * Bounds mirror the decoder's: the result is refused, by name, when it no longer
 * fits `ST_CARD_DECODER_LIMITS_V1.inputBytesPng` - the same ceiling that bounds an
 * importable PNG card, because the exported card is one.
 */
export function writeCompanionCardPng(image: Uint8Array, card: string): Uint8Array {
  if (!isCompletePngFile(image)) throw new Error("companion_card_image_malformed");
  const cardChunk = pngChunk("tEXt", Buffer.from(`${CARD_TEXT_KEYWORD}\u0000${cardBase64(card)}`, "latin1"));
  const parts: Buffer[] = [Buffer.from(PNG_SIGNATURE)];
  for (const chunk of pngChunks(image)) {
    if (isCardTextChunk(chunk.type, chunk.data)) continue;
    parts.push(Buffer.from(image.subarray(chunk.start, chunk.end)));
    if (chunk.type === "IHDR") parts.push(cardChunk);
  }
  const out = Buffer.concat(parts);
  if (out.byteLength > ST_CARD_DECODER_LIMITS_V1.inputBytesPng) throw new Error("companion_card_too_large");
  return out;
}

/** The card's own JSON, exactly as the ecosystem's readers expect to find it. */
function cardBase64(card: string): string {
  return Buffer.from(card, "utf8").toString("base64");
}

const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10] as const);
const CARD_TEXT_KEYWORD = "chara";
/** Every keyword the decoder reads a card from (`st-card-import.ts`, lowercased). */
const CARD_TEXT_KEYWORDS = new Set([CARD_TEXT_KEYWORD, "ccv3", "character"]);
const TEXT_CHUNK_TYPES = new Set(["tEXt", "zTXt", "iTXt"]);

type PngChunkSpan = Readonly<{
  type: string;
  data: Uint8Array;
  /** The chunk's own first byte (its length field) and one past its CRC. */
  start: number;
  end: number;
}>;

/**
 * The image's chunks, as spans into the exact bytes it arrived as. Only ever called
 * after `isCompletePngFile` has accepted the image, so every declared length is
 * known to fit and the walk cannot run off the end.
 */
function pngChunks(image: Uint8Array): readonly PngChunkSpan[] {
  const spans: PngChunkSpan[] = [];
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 12 <= image.length) {
    const length = readU32(image, offset);
    const end = offset + 12 + length;
    const type = ascii(image, offset + 4, 4);
    spans.push(Object.freeze({ type, data: image.subarray(offset + 8, offset + 8 + length), start: offset, end }));
    offset = end;
    if (type === "IEND") break;
  }
  return spans;
}

function isCardTextChunk(type: string, data: Uint8Array): boolean {
  if (!TEXT_CHUNK_TYPES.has(type)) return false;
  const split = data.indexOf(0);
  return split >= 1 && CARD_TEXT_KEYWORDS.has(ascii(data, 0, split).toLowerCase());
}

/** One PNG chunk: length, type, data, and the CRC over type and data. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length && index < bytes.length; index += 1)
    value += String.fromCharCode(bytes[index]!);
  return value;
}
