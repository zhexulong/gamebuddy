import type { messages } from "../i18n";
import type { TavernConnectionApiShapeV1 } from "../management-pipeline-api";

/**
 * What the player reads for each protocol, and the fact that the wire value is not it.
 *
 * The select used to render the slug itself (`openai-completions`, `bedrock-converse-stream`, …),
 * which is the value the Host writes into the runtime's provider entry and not a name anyone says
 * out loud. The value stays exactly what it was - this map only decides the text - because the
 * protocol is what the player's own server has to speak, and `azure-openai-responses` is the only
 * spelling the request can carry.
 *
 * The record is typed over `TavernConnectionApiShapeV1`, so the closed list has one population: a
 * shape added to `CONNECTION_API_SHAPES` fails to compile here until it is given a name, and no
 * protocol can reach the player as its slug because nothing falls through.
 *
 * Only an entry that declares `apiShape` asks this at all. A provider GameBuddy knows pins its own
 * protocol in the catalog (`piApi`), which is why the field the player fills is their endpoint and
 * their model, never a protocol the product already decided.
 */
export const CONNECTION_API_SHAPE_LABELS: Readonly<
  Record<TavernConnectionApiShapeV1, keyof ReturnType<typeof messages>>
> = Object.freeze({
  "anthropic-messages": "connectionShapeAnthropicMessages",
  "azure-openai-responses": "connectionShapeAzureOpenAiResponses",
  "openai-completions": "connectionShapeOpenAiChatCompletions",
  "openai-responses": "connectionShapeOpenAiResponses",
  "openai-codex-responses": "connectionShapeOpenAiCodexResponses",
  "google-generative-ai": "connectionShapeGoogleGemini",
  "google-vertex": "connectionShapeGoogleVertex",
  "bedrock-converse-stream": "connectionShapeBedrockConverse",
  "mistral-conversations": "connectionShapeMistral",
  "pi-messages": "connectionShapePiMessages",
});
