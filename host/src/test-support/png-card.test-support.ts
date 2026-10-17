import { deflateSync } from "node:zlib";

/**
 * A genuinely valid PNG, built byte by byte, for tests and probes that need a
 * picture rather than a description of one. It carries a real IHDR, a real
 * deflated IDAT for a 1x1 opaque red pixel, a real IEND, and real CRCs - so a
 * browser can decode it and a test can assert the bytes that travelled, instead
 * of a stub whose only property is its length.
 *
 * `textChunk` adds one `tEXt` chunk, which is exactly where a SillyTavern card
 * carries its JSON: `pngCardFile(JSON.stringify(card))` is an ST card file whose
 * picture is the real image above.
 */
export function pngFileWithText(keyword: string, value: string): Uint8Array {
  const text = latin1(`${keyword}\u0000${value}`);
  return pngFile([chunk("tEXt", text)]);
}

export function pngCardFile(cardJson: string, keyword = "chara"): Uint8Array {
  return pngFileWithText(keyword, cardJson);
}

/** The same real PNG with no text chunk at all: a picture that carries no card. */
export function pngPictureFile(): Uint8Array {
  return pngFile([]);
}

/** The same real PNG with one empty text chunk: a card that carries nothing readable. */
export function pngCardFileWithoutPayload(): Uint8Array {
  return pngFileWithText("chara", "");
}

/**
 * A file that CARRIES a card and is not a complete PNG container: the signature
 * and the `tEXt` chunk that holds the card, and then nothing - no IHDR, no IDAT,
 * no IEND. The Host's decoder finds its chunk wherever it lies, so this card is
 * perfectly importable while its image is not a picture any browser could render.
 */
export function pngCardFileWithoutImage(cardJson: string): Uint8Array {
  return Buffer.concat([Buffer.from(SIGNATURE), Buffer.from(chunk("tEXt", latin1(`chara\u0000${cardJson}`)))]);
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function pngFile(middle: readonly Uint8Array[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, 1);
  header.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, 255, 0, 0]));
  const parts = [SIGNATURE, chunk("IHDR", ihdr), ...middle, chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function latin1(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}
