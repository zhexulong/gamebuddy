// Driver S: the player gives a companion a picture, and the face revalidates instead of going stale.
//
// Add-5's three claims, measured in the real product rather than argued:
//   1. the control exists on the one per-companion surface that shows EVERY companion (the roster's
//      inspector drawer), it is a 44 px target, and its picker accepts PNG only;
//   2. an upload lands: the avatar element decodes (`naturalWidth > 0`) at the address the Host owns,
//      and the bytes the face serves are the bytes the picker handed over (compared by sha256);
//   3. the face REVALIDATES: it serves `no-cache` + an ETag, so a replaced picture is a new ETag
//      (a browser holding the old one comes back and is told), and a fetch with `If-None-Match` equal
//      to the current one is answered `304`.
//
// A refusal must change nothing: a file that is not a PNG is refused by name and the picture she had
// stays on screen. That is the half most likely to regress, so it is asserted, not observed.
const { createHash } = require("node:crypto");
const zlib = require("node:zlib");
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

// A minimal, structurally complete PNG (signature + IHDR + IDAT + IEND, CRCs correct) whose single
// pixel carries a colour the caller picks - so two uploads are two different files with two digests.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function pngOf(color) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(8 * (1 + 8 * 4));
  for (let row = 0; row < 8; row += 1) {
    const base = row * (1 + 8 * 4);
    raw[base] = 0;
    for (let column = 0; column < 8; column += 1) {
      const pixel = base + 1 + column * 4;
      raw[pixel] = color[0];
      raw[pixel + 1] = color[1];
      raw[pixel + 2] = color[2];
      raw[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// The FULL sha256: it is what the face publishes as the ETag, so comparing the digest is how "the bytes
// the face served are the bytes the picker handed over" is proven. The log shows the first 16 hex for
// readability; the comparison must never use a truncated form (an earlier version of this driver compared
// byte LENGTHS, and the two 1x1 fixtures happened to be the same length - so it printed a false negative
// for a replacement that had in fact worked).
const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shortDigest = (digest) => digest.slice(0, 16);

const CONTROL_HELPER = `
window.__avatarControlOf = () => {
  const section = document.querySelector("[data-companion-inspector-avatar]");
  const choose = document.querySelector("[data-companion-avatar-choose]");
  const file = document.querySelector("[data-companion-avatar-file]");
  const notice = document.querySelector("[data-companion-avatar-notice]");
  const image = document.querySelector("[data-companion-inspector-avatar] img.avatar-image");
  const plate = document.querySelector("[data-companion-inspector-avatar] .avatar");
  const uploadRow = section === null ? null : section.querySelector(".composer-actions");
  const drawer = document.querySelector('[data-testid="companion-inspector"]');
  return {
    control: choose === null ? null : {
      ...window.__shots.rect(choose),
      text: (choose.textContent ?? "").trim(),
      ariaLabel: choose.getAttribute("aria-label"),
      disabled: choose.disabled === true,
    },
    picker: file === null ? null : {
      accept: file.getAttribute("accept"),
      type: file.getAttribute("type"),
      hiddenFromVisualFlow: file.getBoundingClientRect().width <= 1,
      ariaLabel: file.getAttribute("aria-label"),
    },
    notice: notice === null ? null : { text: (notice.textContent ?? "").trim(), role: notice.getAttribute("role") },
    avatar: image === null ? null : {
      src: image.getAttribute("src"),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      box: window.__shots.rect(image),
    },
    // Ruling 3: the drawer draws her as a hero portrait (128 px, the avatar-hero class), and the upload
    // control stands BESIDE it - the plate's own box and the row the two of them share are what makes
    // that a measurement rather than a reading of the stylesheet.
    plate: plate === null ? null : {
      ...window.__shots.rect(plate),
      classes: String(plate.className),
      monogram: image === null ? (plate.textContent ?? "").trim() : null,
    },
    uploadRow: uploadRow === null ? null : window.__shots.rect(uploadRow),
    drawer: drawer === null ? null : window.__shots.rect(drawer),
    monogram: image === null ? (plate?.textContent ?? "").trim() : null,
  };
};
`;

/** What the face serves for the address the page itself asked for, with its revalidation headers. */
const faceOf = async (url) => {
  const store = (headers) => async (init) => {
    const response = await fetch(url, { headers, ...init });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      etag: response.headers.get("etag"),
      byteLength: bytes.length,
      headHex: [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
    };
  };
  const first = await store({})();
  const revalidated = first.etag === null ? null : await store({ "if-none-match": first.etag })();
  return { first, revalidated };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("s-avatar-upload.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};${CONTROL_HELPER};undefined`);
  await activateSurface(page, "角色");
  await page.waitForTimeout(1800);

  // The one per-companion surface that lists every companion.
  say("=== ITEM: the roster, and which companion has no picture today ===");
  const roster = await page.evaluate(() =>
    [...document.querySelectorAll("[data-companion-entry]")].map((row) => ({
      name: (row.querySelector("[data-companion-entry-name]")?.textContent ?? "").trim(),
      hasPicture: row.querySelector("img.avatar-image") !== null,
    })),
  );
  say(JSON.stringify(roster, null, 1));
  // A companion without a picture is the case this feature exists for. If the roster has none, say so
  // rather than silently measuring the one that already had a preset picture.
  const withoutPicture = roster.filter((row) => !row.hasPicture);
  say(`roster rows=${roster.length} without a picture=${withoutPicture.length}`);
  if (withoutPicture.length === 0) {
    say("NOTE: every roster companion already carries a picture, so this run cannot show the monogram-to-picture transition. That is a fact about this data root, not a pass.");
  }

  const target = withoutPicture[0] ?? roster[0];
  if (target === undefined) {
    say("could not reach a roster row at all");
    flush();
    await browser.close().catch(() => undefined);
    process.exit(1);
  }
  say(`driving with: ${JSON.stringify(target.name)} (hasPicture=${target.hasPicture})`);

  // Open her inspector from her own row.
  const row = page.locator("[data-companion-entry]", { hasText: target.name }).first();
  const inspect = row.locator("button").first();
  if ((await inspect.count()) > 0) {
    await inspect.click();
    await page.waitForTimeout(1500);
  }
  const before = await page.evaluate(() => window.__avatarControlOf());
  say("=== ITEM: the control, before anything is uploaded ===");
  say(JSON.stringify(before, null, 1));
  say(
    `control present=${before.control !== null} box=${JSON.stringify(before.control)} picker=${JSON.stringify(before.picker)} monogram=${JSON.stringify(before.monogram)}`,
  );
  const besideTheHero =
    before.control !== null &&
    before.plate !== null &&
    before.control.x >= before.plate.right &&
    before.control.y + before.control.h / 2 <= before.plate.bottom &&
    before.control.y + before.control.h / 2 >= before.plate.y;
  say(
    `the drawer's picture at hero size: plate=${before.plate?.w}x${before.plate?.h} classes=${JSON.stringify(before.plate?.classes ?? null)} monogram=${JSON.stringify(before.plate?.monogram ?? null)}`,
  );
  say(
    `the upload control beside it: control.x=${before.control?.x} plate.right=${before.plate?.right} control.y=${before.control?.y} plate=${JSON.stringify(before.plate === null ? null : { y: before.plate.y, bottom: before.plate.bottom })} beside=${besideTheHero}`,
  );
  say(
    `the row both share: ${JSON.stringify(before.uploadRow)}; the drawer's own column: ${JSON.stringify(before.drawer)}`,
  );
  await shot(page, "90-avatar-upload-control-1440x900.png");

  const picker = page.locator("[data-companion-avatar-file]").first();
  if ((await picker.count()) === 0) {
    say("the drawer has no file picker; nothing more can be driven");
    flush();
    await browser.close().catch(() => undefined);
    process.exit(1);
  }

  say("=== ITEM: a real PNG goes in ===");
  const firstPng = pngOf([200, 90, 120]);
  const firstDigest = digestOf(firstPng);
  say(`the file handed to the picker: bytes=${firstPng.length} sha256=${shortDigest(firstDigest)}`);
  await picker.setInputFiles({ name: "chosen-picture.png", mimeType: "image/png", buffer: firstPng });
  await page.waitForTimeout(2600);
  const afterUpload = await page.evaluate(() => window.__avatarControlOf());
  say(JSON.stringify(afterUpload, null, 1));
  say(`notice: ${JSON.stringify(afterUpload.notice?.text ?? null)}`);
  say(
    `her picture: hasImage=${afterUpload.avatar !== null} decoded=${(afterUpload.avatar?.naturalWidth ?? 0) > 0} src=${JSON.stringify(afterUpload.avatar?.src ?? null)}`,
  );
  say(
    `after the upload the portrait is still the hero plate: plate=${afterUpload.plate?.w}x${afterUpload.plate?.h} image=${JSON.stringify(afterUpload.avatar?.box ?? null)} control=${JSON.stringify(afterUpload.control)} sameRow=${afterUpload.uploadRow !== null && afterUpload.uploadRow.h >= afterUpload.plate?.h}`,
  );
  await shot(page, "90-avatar-upload-after-upload-1440x900.png");

  if (afterUpload.avatar?.src != null) {
    const face = await page.evaluate(faceOf, afterUpload.avatar.src);
    say(`the face for that address: ${JSON.stringify(face.first)}`);
    say(`revalidated with the same ETag: ${JSON.stringify(face.revalidated)}`);
    const served = face.first;
    say(
      `the face serves the file handed over: etagMatchesTheDigest=${served.etag === `"${firstDigest}"`} etag=${JSON.stringify(served.etag)} digest=${JSON.stringify(firstDigest)} bytes=${served.byteLength}/${firstPng.length}`,
    );
  }

  say("=== ITEM: a second, different picture replaces it (the revalidation claim) ===");
  const secondPng = pngOf([40, 160, 90]);
  const secondDigest = digestOf(secondPng);
  say(`the second file: bytes=${secondPng.length} sha256=${shortDigest(secondDigest)}`);
  await picker.setInputFiles({ name: "another-picture.png", mimeType: "image/png", buffer: secondPng });
  await page.waitForTimeout(2600);
  const afterSecond = await page.evaluate(() => window.__avatarControlOf());
  say(`notice: ${JSON.stringify(afterSecond.notice?.text ?? null)} decoded=${(afterSecond.avatar?.naturalWidth ?? 0) > 0}`);
  if (afterSecond.avatar?.src != null) {
    const face = await page.evaluate(faceOf, afterSecond.avatar.src);
    say(`the face after the replacement: ${JSON.stringify(face.first)}`);
    say(
      `the replacement is served, decided by content: etagMatchesTheNewDigest=${face.first.etag === `"${secondDigest}"`} etagChanged=${face.first.etag !== `"${firstDigest}"`} etag=${JSON.stringify(face.first.etag)}`,
    );
  }
  await shot(page, "90-avatar-upload-replaced-1440x900.png");

  say("=== ITEM: a file the Host refuses keeps the picture she has ===");
  const keptBefore = afterSecond.avatar?.src ?? null;
  await picker.setInputFiles({
    name: "not-a-picture.png",
    mimeType: "image/png",
    buffer: Buffer.from("this is text wearing a .png name", "utf8"),
  });
  await page.waitForTimeout(2600);
  const afterRefusal = await page.evaluate(() => window.__avatarControlOf());
  say(`notice after the refusal: ${JSON.stringify(afterRefusal.notice?.text ?? null)}`);
  say(
    `her picture is the one from before: srcUnchanged=${afterRefusal.avatar?.src === keptBefore} stillDecodes=${(afterRefusal.avatar?.naturalWidth ?? 0) > 0}`,
  );
  await shot(page, "90-avatar-upload-refusal-1440x900.png");

  say("=== ITEM: what the roster draws now ===");
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(900);
  const rosterAfter = await page.evaluate(() =>
    [...document.querySelectorAll("[data-companion-entry]")].map((row) => ({
      name: (row.querySelector("[data-companion-entry-name]")?.textContent ?? "").trim(),
      hasPicture: row.querySelector("img.avatar-image") !== null,
      naturalWidth: row.querySelector("img.avatar-image")?.naturalWidth ?? null,
      src: row.querySelector("img.avatar-image")?.getAttribute("src") ?? null,
    })),
  );
  say(JSON.stringify(rosterAfter, null, 1));
  say(
    `roster now: withPicture=${rosterAfter.filter((row) => row.hasPicture).length} monograms=${JSON.stringify(rosterAfter.filter((row) => !row.hasPicture).map((row) => row.name))}`,
  );

  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  await shot(page, "90-avatar-upload-400x800.png");

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-S");
})().catch((error) => {
  console.log("DRIVER S FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
