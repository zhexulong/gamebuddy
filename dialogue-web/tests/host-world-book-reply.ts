import { type CompanionWorldBookV1, validateCompanionWorldBook } from "../src/management-pipeline-api";

/**
 * One `companion.worldbook.read` / `companion.worldbook.update` reply, checked against the mirror the
 * browser applies before it renders anything.
 *
 * Every book a journey stubs is a CLAIM about what the Host answers on that route, and the claim is
 * not harmless when it is wrong: `isCompanionWorldBookEntry` (`management-pipeline-api.ts`) accepts
 * exactly the keys the published contract declares, so a fixture missing one of them is refused
 * whole, the panel takes its `failed` branch, and the journey reports a missing attribute five
 * seconds later - a red that names the DOM instead of the fixture that lied to it.
 *
 * That is what happened when `efbff381` made `enabled` required on an entry: three journeys kept
 * spelling the entry with four keys, and twenty tests were red for two days looking like a product
 * regression on the world book. So the claim is checked here, once, by the product's own validator,
 * and the refusal quotes the body: a fixture of a reply the Host cannot produce now fails at the line
 * that stubs it, with the reply in the message.
 */
export function hostWorldBookReply(body: unknown): CompanionWorldBookV1 {
  try {
    return validateCompanionWorldBook(body);
  } catch (error) {
    throw new Error(
      `this journey stubs a world book the browser refuses, so the panel would render its failed ` +
        `branch: ${String(error)} - the body was ${JSON.stringify(body).slice(0, 600)}`,
    );
  }
}
