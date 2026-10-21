/**
 * A picked file's bytes as the contract speaks them, whether a picked file is a PNG
 * card, and the PNG an uploaded picture becomes.
 *
 * `isPngCardFile` used to also READ the card: it walked the PNG chunks, inflated a
 * `zTXt`/`iTXt` payload, base64-decoded the `chara` value and handed the JSON text to the
 * stage route. That made the browser a second authority on what a card says - and on the
 * pairing of the card's fields with the file they came from, a pairing no Host could check
 * because the two arrived as different fields. A PNG card's picture and its card are the
 * same object, so the route now takes the whole file and the Host's own decoder reads both
 * out of the one byte string it received. All the browser has to decide is WHICH arm of
 * that union a picked file takes, and the file's own eight signature bytes decide that -
 * not its extension, not its MIME type, neither of which the Host would believe either.
 *
 * `canonicalBase64Of` is the other half of that job, in the one spelling both routes take:
 * the card import sends a picked PNG card with it, and the avatar upload sends a picked
 * picture with it. The Host re-encodes what it decodes and refuses a payload that does not
 * match, so this has to be the standard padded encoding - which is what `btoa` produces -
 * and never a shortened or line-broken variant.
 *
 * `pngBytesOfPickedPicture` is the third: the picture a player picks for her is not
 * required to already be a PNG.
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export function isPngCardFile(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  return true;
}

/**
 * Canonical base64 of the whole file: padding, no whitespace, no line breaks.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a 32 MiB picture overflows the
 * argument limit long before it exhausts anything else.
 */
export function canonicalBase64Of(bytes: Uint8Array): string {
  const CHUNK_BYTES = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_BYTES));
  return btoa(binary);
}

/**
 * A picture the player picked, as the complete PNG the avatar route keeps.
 *
 * The Host's avatar writer accepts a PNG and nothing else - `isCompletePngFile` walks the
 * container of the bytes it received, and that check stays exactly as strict as it is,
 * because what it protects is the file the asset face later serves. What it never asked
 * is what the PLAYER's file was: a JPEG or WebP portrait is an ordinary picture, and
 * refusing it made a player re-encode their own portrait before she could have a face.
 *
 * So the conversion happens here, before a byte is sent: the browser decodes the picked
 * file, the pixels are drawn onto a canvas of the picture's own size, and the browser's
 * own PNG encoder produces the bytes the upload carries. The Host's contract is unchanged
 * - it receives one complete PNG - and no player is asked to know what a container is.
 *
 * `null` is "this browser could not decode the file as a picture": a different fact from
 * any Host refusal, and the one case the caller answers in its own words instead of
 * sending bytes the Host would refuse. `OffscreenCanvas` is what keeps the conversion out
 * of the document - nothing is mounted to transcode a picture - and `convertToBlob` is
 * the encoder the browser already ships.
 */
export async function pngBytesOfPickedPicture(file: Blob): Promise<Uint8Array | null> {
  let picture: ImageBitmap;
  try {
    picture = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const canvas = new OffscreenCanvas(picture.width, picture.height);
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(picture, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await png.arrayBuffer());
  } catch {
    return null;
  } finally {
    picture.close();
  }
}
