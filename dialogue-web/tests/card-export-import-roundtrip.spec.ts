import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./frontend-coverage";
import { characterHandle, csrfToken, jsonOk, token } from "./composed-reference-game-fixtures";
import { importIdHandle, openCharactersSurface, stagedCard, stubCharacterReads } from "./character-card-fixtures";

/**
 * The card the surface saves is the card the surface takes back.
 *
 * The claim this file decides: "the exported card cannot be re-imported". Two readings of one
 * observation disagreed about where it broke - the product's file input, or the driver that
 * injected the file - and neither reading is a measurement. What is measured here is the whole
 * loop in one mounted page: press the PNG export control, take the bytes the browser was handed,
 * give those exact bytes back to the surface's own picker, and compare the card that reaches the
 * Host with the card the export carried, field by field.
 *
 * Why the file input's own order matters enough to have a file about it: the input resets
 * `value` inside `onChange` so that choosing the SAME file twice still fires `change`. That reset
 * empties `input.files` (measured: a re-read of `files[0]` after it is `null`), so the handler
 * must hold the `File` it captured BEFORE the reset and never look at `files` again. The two
 * shapes that would break are "clear the value, then read `files[0]`" and "await, then read
 * `files[0]`"; the second import in a row is the shape that goes through a picker whose files
 * list was emptied by the first.
 *
 * The assertions, and the failure each one catches:
 *  - the edited `chara` chunk of the export decodes to the card this file built: catches an export
 *    that saved something other than the Host's card;
 *  - the bytes the import sends are byte-identical to the bytes the export saved: catches a
 *    browser-side re-encoding (a shortened base64, a text arm taken for a PNG arm);
 *  - every field of the card inside those bytes equals the exported card's field, and the key sets
 *    match exactly: catches a field dropped, renamed or added on the way back;
 *  - no `data-card-import-result=error` appears: catches the failure the two readings argued
 *    about, whatever its cause, instead of assuming which one it is;
 *  - a second pick of the same file stages a second card: catches the regression the value reset
 *    exists to prevent, which nothing asserted before.
 */

/** The card the companion's own export carries: every field a v3 card can hold. */
const EXPORTED_CARD = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "琥珀",
    description: "她在祖辈留下的农场里长大,话不多,先做一个动作再说一句话。",
    personality: "沉静,务实,对天气和土壤有耐心。",
    scenario: "你们一起在祖辈留下的农场里开始新的生活。",
    first_mes: "她把锄头靠在门边,看了你一眼。",
    mes_example: "<START>\n{{char}}: 温室的门开着,里面的番茄红了。",
    post_history_instructions: "回复保持简短,以一个动作开头。",
    system_prompt: "先做一个动作,再说一句话。",
    alternate_greetings: ["雨停了,屋檐还在滴水。", "她递给你一杯还烫手的茶。"],
    creator_notes: "为农场清晨写的角色。",
    tags: ["farm", "companion"],
    creator: "gamebuddy",
    character_version: "1.2.0",
    extensions: { talkativeness: "0.4", depth_prompt: { prompt: "农场", depth: 4 } },
    character_book: {
      scan_depth: 5,
      entries: [
        { comment: "温室", content: "温室是她去年冬天自己修好的。", keys: ["温室", "玻璃房"], constant: false },
        { comment: "农场", content: "农场在河谷的北边,春天会淹一次。", keys: ["农场"], constant: true },
      ],
    },
  },
} as const;

/* ---------------------------------------------------------------------------
   The Host's PNG card file, built here rather than pasted.

   The production writer is `host/src/tavern/png-card-writer.ts`, and this zone cannot import
   it: the browser bundle is the artifact under test, and a journey that reached into the Host's
   source would be testing a second consumer of it. What the fixture has to be is a real PNG -
   signature, IHDR, the `chara` `tEXt` chunk carrying the card as base64, IDAT, IEND, every chunk
   CRC'd - because the surface decides which arm a picked file takes from those eight signature
   bytes, and asserts the picture decodes as an image below.
   --------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32Of = (bytes: Buffer): number => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, payload: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Of(body));
  return Buffer.concat([length, body, crc]);
};

/** One complete PNG card: a 64x64 picture whose `chara` chunk carries `card` as base64. */
const pngCardOf = (card: unknown, width = 64): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Every scanline is a filter byte (0) followed by the row's four bytes per pixel. The pixels
  // are a gradient, so the file is a picture a decoder accepts and not a block of noise.
  const scanlines = Buffer.alloc((1 + width * 4) * width);
  for (let row = 0; row < width; row += 1)
    for (let column = 0; column < width; column += 1) {
      const at = row * (1 + width * 4) + 1 + column * 4;
      scanlines[at] = row * 4;
      scanlines[at + 1] = column * 4;
      scanlines[at + 2] = 128;
      scanlines[at + 3] = 255;
    }
  const chara = Buffer.concat([
    Buffer.from("chara\0", "latin1"),
    // The card travels as the standard padded base64 the Host's own writer emits, never as text:
    // a `chara` value that is not base64 is a card nothing can read back out of the picture.
    Buffer.from(Buffer.from(JSON.stringify(card), "utf8").toString("base64"), "latin1"),
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", chara),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/** The card a PNG's own `chara` chunk carries, read back the way the Host reads it. */
const cardOfPng = (bytes: Buffer): unknown => {
  const prefix = Buffer.from("chara\0", "latin1");
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt" && payload.subarray(0, prefix.length).equals(prefix))
      return JSON.parse(Buffer.from(payload.subarray(prefix.length).toString("latin1"), "base64").toString("utf8"));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return null;
};

/** The same card, but with `data.name` replaced - the report the Host stages names it. */
const staleReport = (): Record<string, unknown> => ({ ...stagedCard(), name: EXPORTED_CARD.data.name });

/** The Characters surface, its export route, and its three import routes, all stubbed. */
async function mountCharacters(
  page: import("@playwright/test").Page,
  pngBytes: Buffer,
): Promise<{ stageBodies: Array<Record<string, unknown>> }> {
  await stubCharacterReads(page, {
    companions: [{ handle: characterHandle, name: EXPORTED_CARD.data.name, isCurrent: true }],
  });
  await page.route(
    (url) => url.pathname === `/api/tavern/v1/companions/${characterHandle}/card`,
    (route) =>
      route.fulfill(
        jsonOk({
          apiVersion: 1,
          format: "png",
          spec: "chara_card_v3",
          fileName: `${EXPORTED_CARD.data.name}.png`,
          cardFileBase64: pngBytes.toString("base64"),
        }),
      ),
  );
  const stageBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/tavern/v1/imports", async (route) => {
    stageBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill(jsonOk(staleReport()));
  });
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, importId: importIdHandle, reviewedFields: ["name", "persona_core"], approvedAtMs: 1 }),
    ),
  );
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, name: EXPORTED_CARD.data.name })),
  );
  return { stageBodies };
}

/** One press of the PNG export control, and the bytes the browser was handed. */
async function exportPng(page: import("@playwright/test").Page): Promise<Buffer> {
  const section = page.getByTestId("characters-surface").locator("[data-companion-card-export-section]");
  const control = section.locator("[data-companion-card-export-png]");
  await expect(control).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), control.click()]);
  expect(download.suggestedFilename(), "the saved file is named for the form and the companion").toBe(
    `${EXPORTED_CARD.data.name}.png`,
  );
  const path = await download.path();
  expect(path, "the download completes").not.toBeNull();
  return await import("node:fs/promises").then((fs) => fs.readFile(path!));
}

test("the card her export saves is the card this surface takes back, field for field", async ({ page }) => {
  const pngBytes = pngCardOf(EXPORTED_CARD);
  const { stageBodies } = await mountCharacters(page, pngBytes);
  const browserProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserProblems.push(message.text());
  });
  page.on("pageerror", (error) => browserProblems.push(String(error)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  const saved = await exportPng(page);
  expect(saved.subarray(0, 8), "the saved file is a PNG card").toEqual(pngBytes.subarray(0, 8));
  expect(cardOfPng(saved), "the exported file carries the card this file built").toEqual(EXPORTED_CARD);
  // The saved file decodes as a picture in this browser: a `chara` chunk framed wrong (a length
  // or CRC that does not match its bytes) is exactly what stops an image decoder here.
  const decodedPicture = await page.evaluate(async (bytes: number[]) => {
    const image = new Image();
    image.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    try {
      await image.decode();
    } catch {
      /* the natural size below is the assertion */
    }
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, Array.from(saved));
  expect(decodedPicture, "the saved card file is a picture a decoder accepts").toEqual({ width: 64, height: 64 });

  // The player gives the saved file straight back to the surface's own picker.
  await surface.locator("[data-card-import-file]").setInputFiles({
    name: `${EXPORTED_CARD.data.name}.png`,
    mimeType: "image/png",
    buffer: saved,
  });
  const review = surface.locator("[data-card-import-review]");
  await expect(review, "the exported card stages a review, so it can be re-imported").toBeVisible();
  await expect(surface.locator("[data-card-import-result=error]")).toHaveCount(0);
  await expect(review).toContainText(`The card names it ${EXPORTED_CARD.data.name}.`);

  // What the surface sent is the whole file, unaltered: the PNG arm, the same bytes.
  expect(stageBodies.length, "one pick staged one card").toBe(1);
  expect(stageBodies[0]!.apiVersion).toBe(1);
  expect(stageBodies[0]!.cardSource, "a PNG card travels as a file, not as text").toBe("png");
  const sent = Buffer.from(String(stageBodies[0]!.cardFileBase64), "base64");
  expect(Buffer.compare(sent, saved), "the bytes sent back are the bytes the export saved").toBe(0);

  // Field by field, named: a mismatch says which field drifted, not just that the objects differ.
  const returned = cardOfPng(sent) as { spec?: unknown; spec_version?: unknown; data?: Record<string, unknown> };
  expect(returned.spec, "the card's spec survived").toBe(EXPORTED_CARD.spec);
  expect(returned.spec_version, "the card's spec_version survived").toBe(EXPORTED_CARD.spec_version);
  expect(Object.keys(returned.data ?? {}).sort(), "no card field was added or lost").toEqual(
    Object.keys(EXPORTED_CARD.data).sort(),
  );
  for (const field of Object.keys(EXPORTED_CARD.data))
    expect(
      returned.data?.[field],
      `the card's data.${field} survived the round trip unchanged`,
    ).toEqual(EXPORTED_CARD.data[field as keyof typeof EXPORTED_CARD.data]);

  // The player approves the review: the companion exists, named by the Host's own read-back.
  await review.locator("[data-card-import-review-confirm]").click();
  const created = surface.locator("[data-card-import-result=created]");
  await expect(created).toContainText(`Imported ${EXPORTED_CARD.data.name}.`);
  expect(browserProblems, "the round trip logged nothing to the console").toEqual([]);
});

test("the same card imports twice in a row", async ({ page }) => {
  const pngBytes = pngCardOf(EXPORTED_CARD);
  const { stageBodies } = await mountCharacters(page, pngBytes);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");
  const picker = surface.locator("[data-card-import-file]");
  const file = { name: `${EXPORTED_CARD.data.name}.png`, mimeType: "image/png", buffer: pngBytes };

  // The same File twice: the input resets `value` inside onChange so the second pick still
  // fires `change`. Without that reset the browser sees an unchanged file list and stages
  // nothing - a player who wants the same card again would press the picker and get silence.
  for (const pick of ["first", "second"] as const) {
    await picker.setInputFiles(file);
    await expect(
      surface.locator("[data-card-import-review]"),
      `the ${pick} pick of the same file stages a card`,
    ).toBeVisible();
    await expect.poll(() => stageBodies.length, { message: `the ${pick} pick reached the Host` }).toBe(
      pick === "first" ? 1 : 2,
    );
    await surface.locator("[data-card-import-review-cancel]").click();
    await expect(surface.locator("[data-card-import-review]"), "the staged card was dropped").toHaveCount(0);
  }

  expect(stageBodies.length, "two picks staged two cards").toBe(2);
  expect(stageBodies[1]!.cardFileBase64, "the second pick sent the same bytes as the first").toBe(
    stageBodies[0]!.cardFileBase64,
  );
});

test("the visible control opens the browser's own chooser, and a file it names is read", async ({ page }) => {
  const pngBytes = pngCardOf(EXPORTED_CARD);
  const { stageBodies } = await mountCharacters(page, pngBytes);

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");

  // A real path on disk, not an injected buffer: this is the shape a player's picker produces,
  // where the browser reads the bytes from the file the player chose.
  const directory = mkdtempSync(join(tmpdir(), "gb-card-roundtrip-"));
  const path = join(directory, `${EXPORTED_CARD.data.name}.png`);
  writeFileSync(path, pngBytes);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    surface.locator("[data-card-import-trigger]").click(),
  ]);
  await chooser.setFiles(path);
  await expect(surface.locator("[data-card-import-review]"), "the chosen file stages a card").toBeVisible();
  await expect(surface.locator("[data-card-import-result=error]")).toHaveCount(0);
  expect(stageBodies.length).toBe(1);
  expect(Buffer.compare(Buffer.from(String(stageBodies[0]!.cardFileBase64), "base64"), pngBytes)).toBe(0);
});
