import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { decodeStCard, stCardAvatar } from "../st-card-import.js";
import { pngCardFile, pngCardFileWithoutImage, pngPictureFile } from "../test-support/png-card.test-support.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./compatibility-manifest.v1.js";
import { writeCompanionCardPng } from "./png-card-writer.js";

const CARD = JSON.stringify({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "琥珀",
    description: "她是鹈鹕镇的农夫。",
    first_mes: "早上好。今天的风很适合播种。",
    character_book: { scan_depth: 5, entries: [{ comment: "温室", content: "她修好的。", keys: ["温室"] }] },
  },
});

/** One chunk of a PNG, as the test's own reader sees it. */
type Chunk = Readonly<{ type: string; data: Buffer; crcOk: boolean }>;

/**
 * The test's own PNG reader: the eight signature bytes, then every chunk's
 * length, type, data and CRC. It is deliberately a second implementation (its own
 * CRC table below), so a writer whose framing is wrong fails here rather than
 * agreeing with itself.
 */
function readChunks(input: Uint8Array): readonly Chunk[] {
  const bytes = Buffer.from(input);
  const signature = Array.from(bytes.subarray(0, 8));
  assert.deepEqual(signature, [137, 80, 78, 71, 13, 10, 26, 10], "the file starts with the PNG signature");
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + 12 + length <= bytes.length, `chunk at ${offset} stays inside the file`);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const crc = bytes.readUInt32BE(offset + 8 + length);
    chunks.push(Object.freeze({ type, data, crcOk: crc === crc32(bytes.subarray(offset + 4, offset + 8 + length)) }));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
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

/** The card chunks a file carries, in order, as `{keyword, value}` pairs. */
function cardTextChunks(bytes: Uint8Array): readonly Readonly<{ keyword: string; value: string }>[] {
  return readChunks(bytes)
    .filter((chunk) => chunk.type === "tEXt")
    .flatMap((chunk) => {
      const split = chunk.data.indexOf(0);
      if (split < 1) return [];
      const keyword = chunk.data.subarray(0, split).toString("latin1");
      if (!["chara", "ccv3", "character"].includes(keyword.toLowerCase())) return [];
      return [Object.freeze({ keyword, value: chunk.data.subarray(split + 1).toString("latin1") })];
    });
}

test("the writer frames a real PNG: signature, IHDR, one card chunk, the image's own chunks, IEND", () => {
  const image = pngPictureFile();
  const out = writeCompanionCardPng(image, CARD);
  const chunks = readChunks(out);

  assert.equal(chunks[0]!.type, "IHDR", "IHDR is first");
  assert.equal(chunks[chunks.length - 1]!.type, "IEND", "IEND is last");
  assert.ok(
    chunks.every((chunk) => chunk.crcOk),
    "every chunk's CRC is the CRC over its own type and data",
  );

  // The card chunk is written directly after IHDR, before any other chunk, so no
  // earlier card chunk can shadow it.
  const cardChunkIndex = chunks.findIndex((chunk) => chunk.type === "tEXt");
  assert.equal(cardChunkIndex, 1, "the card chunk follows IHDR");
  assert.deepEqual(cardTextChunks(out), [{ keyword: "chara", value: Buffer.from(CARD, "utf8").toString("base64") }]);

  // The picture's own chunks survive byte for byte around the one added chunk.
  const imageNonCard = readChunks(image).filter((chunk) => chunk.type !== "tEXt");
  const outNonCard = chunks.filter((chunk) => chunk.type !== "tEXt");
  assert.deepEqual(
    outNonCard.map((chunk) => [chunk.type, chunk.data.toString("base64")]),
    imageNonCard.map((chunk) => [chunk.type, chunk.data.toString("base64")]),
  );
});

test("the written card is an image a real decoder decodes, not only a chunk chain our reader can walk", () => {
  const image = pngPictureFile();
  const out = writeCompanionCardPng(image, CARD);
  const chunks = readChunks(out);

  // The header still declares the picture's own frame.
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")!;
  assert.equal(ihdr.data.readUInt32BE(0), 1, "the image is still 1 pixel wide");
  assert.equal(ihdr.data.readUInt32BE(4), 1, "the image is still 1 pixel tall");

  // `zlib` runs the same inflate a browser's PNG decoder runs, so the pixels - the
  // filter byte and the RGB triple the picture was built from - prove the bytes the
  // writer emitted decode as an image rather than merely walking as chunks.
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  assert.deepEqual([...inflateSync(idat)], [0, 255, 0, 0]);

  // And the import's own picture decision accepts the file the route serves.
  const avatar = stCardAvatar(out);
  assert.equal(avatar.state, "present");
  if (avatar.state !== "present") return;
  assert.deepEqual(avatar.bytes, out);
});

test("the card comes back byte-identical through our own decoder's chunk walk", () => {
  for (const card of [CARD, JSON.stringify({ spec: "chara_card_v3", data: { name: "Solo" } })]) {
    const out = writeCompanionCardPng(pngPictureFile(), card);
    // Walk the chunks the writer produced and decode the value it carried: the
    // bytes are the card's own, not a re-serialization of them.
    const [carried] = cardTextChunks(out);
    assert.equal(carried?.keyword, "chara");
    assert.equal(Buffer.from(carried!.value, "base64").toString("utf8"), card);

    // And the decoder's public entry reads the same card out of the whole file.
    const decoded = decodeStCard(out);
    assert.equal(decoded.source, "png");
    assert.equal(decoded.format, "st-v3");
    assert.equal(decoded.candidate?.profileCandidate.identity.name, JSON.parse(card).data.name);
    assert.equal(decoded.losses.length, 0);
  }
});

test("a stale card chunk in the picture is dropped, so the export carries THIS card and not the one she came from", () => {
  // Her picture IS the card file she was imported from, so its bytes already carry
  // that card. The writer must not leave it where the decoder would meet it first.
  const stale = JSON.stringify({ spec: "chara_card_v3", data: { name: "旧卡片", first_mes: "旧的开场白。" } });
  const image = pngCardFile(stale);
  const out = writeCompanionCardPng(image, CARD);

  const cardChunks = cardTextChunks(out);
  assert.equal(cardChunks.length, 1, "exactly one card chunk remains");
  assert.equal(cardChunks[0]!.keyword, "chara");
  assert.equal(Buffer.from(cardChunks[0]!.value, "base64").toString("utf8"), CARD);
  const decoded = decodeStCard(out);
  assert.equal(
    decoded.candidate?.profileCandidate.identity.name,
    "琥珀",
    "the decoder reads the new card, not the stale one",
  );
});

test("metadata that is not a card survives the write byte for byte", () => {
  const comment = pngCardFile("a note", "Software");
  const out = writeCompanionCardPng(comment, CARD);
  const software = readChunks(out).find(
    (chunk) => chunk.type === "tEXt" && chunk.data.subarray(0, chunk.data.indexOf(0)).toString("latin1") === "Software",
  );
  assert.notEqual(software, undefined, "the non-card text chunk is still there");
  assert.equal(software!.data.subarray(software!.data.indexOf(0) + 1).toString("latin1"), "a note");
});

test("a picture that is not a complete PNG is refused by name, and so is a result past the decoder's own PNG bound", () => {
  assert.throws(() => writeCompanionCardPng(pngCardFileWithoutImage(CARD), CARD), /companion_card_image_malformed/);
  assert.throws(() => writeCompanionCardPng(Buffer.from("not a png at all"), CARD), /companion_card_image_malformed/);

  // A picture already at the decoder's own ceiling cannot carry a card as well;
  // the writer refuses by the same name the export route speaks.
  const oversized = pngCardFile("x".repeat(ST_CARD_DECODER_LIMITS_V1.inputBytesPng), "Software");
  assert.ok(oversized.length > ST_CARD_DECODER_LIMITS_V1.inputBytesPng);
  assert.throws(() => writeCompanionCardPng(oversized, CARD), /companion_card_too_large/);
});
