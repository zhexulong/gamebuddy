// Machine-checkable statement of design/10 §6.1's supportsCancellation rule:
// a Stardew action is cancellable iff its handler (or the single helper it
// directly delegates to) assigns one of the execution lanes the controller's
// `Cancel()` actually checks. The lane list is read from the same source file
// that implements `Cancel`, so the rule cannot drift from the authority.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INTEGRATIONS = resolve(fileURLToPath(new URL("../integrations/stardew", import.meta.url)));
const CONTROLLER_DIR = resolve(INTEGRATIONS, "farmhandexecutioncontroller.cs");
const PARTIAL_DIR = INTEGRATIONS;

/** Lanes the ExecutionManager.Cancel() method actually checks. */
export const CANCEL_LANES = Object.freeze([
  "active",
  "activeTravel",
  "activePet",
  "activeAnimalProduct",
  "activeItemUse",
  "activeItemPickup",
  "activeNavigate",
]);

const SLOT_ASSIGN_RE = /\bthis\.(active(?:[A-Z]\w*)?)\s*=/g;

function bodyOf(text, methodStart) {
  const next = text.slice(methodStart + 10).search(/\n\s{4}(?:public|private|internal)\s/);
  return next === -1 ? text.slice(methodStart) : text.slice(methodStart, methodStart + 10 + next);
}

function loadPartialTexts() {
  const files = readdirSync(PARTIAL_DIR).filter(
    (f) => f.startsWith("farmhandexecutioncontroller") && f.endsWith(".cs"),
  );
  return new Map(files.map((f) => [f, readFileSync(resolve(PARTIAL_DIR, f), "utf8")]));
}

function collectSlots(text, start) {
  const slots = [];
  for (const m of bodyOf(text, start).matchAll(SLOT_ASSIGN_RE)) {
    if (CANCEL_LANES.includes(m[1])) slots.push(m[1]);
  }
  return [...new Set(slots)];
}

function findMethod(texts, name) {
  for (const t of texts.values()) {
    const m = new RegExp(`(?:public|private)\\s+LocalExecutionReceipt\\s+${name}\\s*\\(`).exec(t);
    if (m) return { text: t, index: m.index };
  }
  return undefined;
}

export function deriveCancellableHandlers() {
  const texts = loadPartialTexts();
  const rows = [];
  for (const [f, text] of texts) {
    for (const m of text.matchAll(/public LocalExecutionReceipt (RequestLocal\w+)\(/g)) {
      const name = m[1];
      let slots = collectSlots(text, m.index);
      let followedVia;
      const via = /\breturn\s+this\.(\w+)\s*\(/.exec(bodyOf(text, m.index));
      if (via && slots.length === 0) {
        const target = findMethod(texts, via[1]);
        if (target) {
          slots = collectSlots(target.text, target.index);
          followedVia = via[1];
        }
      }
      rows.push({ handler: name, file: f, cancellable: slots.length > 0, slots, via: followedVia });
    }
  }
  return rows;
}

/**
 * The wire actions that are cancellable, projected from the handler derivation.
 * The actionId is the RequestLocal suffix lowerCamelCase mapped to the Mod
 * registration id; the mapping is one-directional only for known renames.
 */
export function deriveCancellableActionIds() {
  // Handler names map to Mod registration ids; the handful that can't be
  // derived by lowerCamelCase are listed explicitly (Move -> move_to_tile).
  const rename = new Map([
    ["Move", "move_to_tile"],
    ["EnterExit", "enter_exit"],
    ["PickupItem", "pickup_item"],
    ["UseItem", "use_item"],
    ["CollectAnimalProduct", "collect_animal_product"],
    ["PetAnimal", "pet_animal"],
  ]);
  return deriveCancellableHandlers()
    .filter((r) => r.cancellable)
    .map((r) => {
      const name = r.handler.replace(/^RequestLocal/, "");
      return rename.get(name) ?? name[0].toLowerCase() + name.slice(1);
    })
    .sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = deriveCancellableHandlers();
  for (const r of rows) {
    console.log(`${r.handler.padEnd(26)} ${r.cancellable ? "YES" : "no "}  ${r.slots.join(",")}${r.via ? `  (via ${r.via})` : ""}`);
  }
}