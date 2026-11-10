// The capture roster: which drivers the run executes, in the order it runs them, and the facts file each
// one writes.
//
// It lives here, apart from the phase that spawns them, because TWO phases need the same list and a
// hand-kept copy in each is the drift this repository keeps paying for: `capture.mjs` runs the roster, and
// `report.mjs` reconciles each driver's facts file back into REPORT.txt. The report's copy had already
// drifted - it stopped at `r-card-export`, so the drivers added after it wrote their `INJECTION` and
// `CAPABILITY` lines into files the report never opened, where a silent driver and an unreported one
// looked alike. Deriving both from this one module is what makes a driver added here appear in the report
// without anyone remembering to add it twice.
//
// A driver is its own process, writes its own facts file, and is skipped when its per-run marker exists
// (unless `--force`), so a crashed driver can be re-run without redoing the survivors.
export const DRIVERS = Object.freeze([
  { key: "a-surfaces", file: "a-surfaces.cjs", out: "a-surfaces.txt" },
  { key: "b-characters", file: "b-characters.cjs", out: "b-characters.txt" },
  { key: "c-settings", file: "c-settings.cjs", out: "c-settings.txt" },
  { key: "d-game", file: "d-game.cjs", out: "d-game.txt" },
  { key: "e-chats-rows", file: "e-chats-rows.cjs", out: "e-chats-rows.txt" },
  { key: "f-turn-variant", file: "f-turn-variant.cjs", out: "f-turn-variant.txt" },
  { key: "g-defects", file: "g-defects.cjs", out: "g-defects.txt" },
  { key: "h-probe", file: "h-probe.cjs", out: "h-probe.txt" },
  { key: "i-followup", file: "i-followup.cjs", out: "i-followup.txt" },
  { key: "j-card-import", file: "j-card-import.cjs", out: "j-card-import.txt" },
  { key: "k-chat-select", file: "k-chat-select.cjs", out: "k-chat-select.txt" },
  // The surfaces the overnight work added or changed, so a new feature lands with a driver that
  // measures it rather than only with a screenshot nobody can read back: the companion's picture,
  // the read-only inspector, and the World Info library's authoring panel.
  { key: "l-new-surfaces", file: "l-new-surfaces.cjs", out: "l-new-surfaces.txt" },
  // The surfaces the night's work landed after the previous set: the opening a new Chat starts on,
  // the message editor in a player row's own strip, her picture (app bar, roster, transcript and the
  // monogram a card without one gets), the rewind and the delete, her own world book's authoring
  // editor, and the character card in both forms. The order is the run's own: switching conversations
  // and creating Chats is what the opening driver does, so the drivers that read the OPEN conversation
  // run after the editor has made sure one with a message of its own is mounted, and the picture
  // driver runs once such a transcript exists (a player row is part of what it measures).
  { key: "m-opening-picker", file: "m-opening-picker.cjs", out: "m-opening-picker.txt" },
  { key: "n-message-edit", file: "n-message-edit.cjs", out: "n-message-edit.txt" },
  { key: "o-companion-picture", file: "o-companion-picture.cjs", out: "o-companion-picture.txt" },
  { key: "p-rewind-delete", file: "p-rewind-delete.cjs", out: "p-rewind-delete.txt" },
  { key: "q-companion-world-book", file: "q-companion-world-book.cjs", out: "q-companion-world-book.txt" },
  { key: "r-card-export", file: "r-card-export.cjs", out: "r-card-export.txt" },
  { key: "s-avatar-upload", file: "s-avatar-upload.cjs", out: "s-avatar-upload.txt" },
  // The Game surface's installation-discovery panel: its sentence against the Host's own answer for the
  // same moment, read through the product's own route (see the driver's own header).
  { key: "t-installation-discovery", file: "t-installation-discovery.cjs", out: "t-installation-discovery.txt" },
  // The read-only preset surface: the entry switch, the markers with no content source, the macros this
  // product will not evaluate, the depth injection and the sampling in force - read out of the DOM the
  // product painted and held against the preset document the checkout carries (see the driver's header).
  { key: "u-preset-assembly", file: "u-preset-assembly.cjs", out: "u-preset-assembly.txt" },
  // The three authored-context claims, read in both directions from this run's own wire: her memory
  // (written and archived through the management route - INJECTION PATH, NOT FOLD), her world book (one
  // fixture book, one `enabled` flag flipped), and the preset's sampling values (which this product does
  // not bind to a runtime - see the driver's header). Last, because it edits and then restores durable
  // state: a driver that ran after it would read the book it temporarily changed.
  { key: "v-injection-claims", file: "v-injection-claims.cjs", out: "v-injection-claims.txt" },
]);
