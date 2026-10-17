/**
 * Is this picked file a PNG character card?
 *
 * That is the whole module. It used to also READ the card: it walked the PNG
 * chunks, inflated a `zTXt`/`iTXt` payload, base64-decoded the `chara` value and
 * handed the JSON text to the stage route. That made the browser a second
 * authority on what a card says - and on the pairing of the card's fields with
 * the file they came from, a pairing no Host could check because the two arrived
 * as different fields.
 *
 * A PNG card's picture and its card are the same object, so the route now takes
 * the whole file and the Host's own decoder reads both out of the one byte string
 * it received. All the browser has to decide is WHICH arm of that union a picked
 * file takes, and the file's own eight signature bytes decide that - not its
 * extension, not its MIME type, neither of which the Host would believe either.
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export function isPngCardFile(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  return true;
}
