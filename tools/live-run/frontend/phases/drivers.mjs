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
  // The three authored-context claims, read in both directions from this run's own wire: her memory (one
  // durable row, created and archived through the management route - INJECTION PATH, NOT FOLD - and read
  // in the `<project-memory>` block of a Chat mounted after the write), her world book (one fixture book,
  // one `enabled` flag flipped), and the preset in force (marker strings in the blocks their placement rule
  // names, plus the sampler value spliced into `models.json` at mount - seeded by the launch phase because
  // the product has no import or bind route, see lib/preset-seed.mjs). The two measured claims take their
  // directions across mounts and the preset's across an unbind, so this driver leaves five Chats behind; it
  // runs last because it edits and then restores durable state, and a driver that ran after it would read the
  // book it temporarily changed.
  { key: "v-injection-claims", file: "v-injection-claims.cjs", out: "v-injection-claims.txt" },
  // The product's headline path, and the only driver that opens the game: register the installation,
  // activate the lifecycle, ask the Host to launch, say one line into the Game surface and read the
  // companion's answer back - or name the prerequisite this machine does not hold
  // (`not_measured: guardian_pipe_unreachable`, see the driver's header). It is in the default roster
  // because a frontend run that never opened the game did not cover the path the product exists for;
  // its own budgets bound the cost of a machine that HAS the game, and its start checks what this
  // machine has before a browser is touched, so a machine without it pays a second and gets a named
  // `not_measured` line rather than a silent hole in the report. What this one needs, in the driver's
  // own words (`machinePrerequisites` and `probes/prerequisite-check.mjs` `launch:chain`): the Stardew
  // installation, SMAPI beside it, the Mod built and deployed, and a generation that ships the resident
  // Guardian image (`roleBroker.mode: armable`). `requiresGame` is the machine fact that justifies its
  // place in the default roster, not a gate: the driver still runs where the game is absent, and says so.
  { key: "w-game-launch", file: "w-game-launch.cjs", out: "w-game-launch.txt", requiresGame: true },
  // The states a player actually meets AFTER a launch, which "did it start" does not cover: the game dying under
  // a turn (driver X), the explicit endgame that must still settle in the session that saw the exit - invariant
  // 506 (driver Y), and the surface disconnecting while the game keeps running (driver Z).
  //
  // `ownWorld` IS THE ONE FACT THAT DECIDES WHICH DRIVERS SHARE A MOUNTED HOST, and it is `true` here because each
  // of these three scenarios ENDS or OCCUPIES the world it is measured on (x kills it, y ends it, z is measured on
  // its staying up). The product draws neither the launch nor the activation control while an instance exists
  // (`dialogue-web/src/game-lifecycle-controls.ts:93-101`), and its step out of a world it has ended is
  // `restart_gamebuddy`, outside the surface (`:426-430`) - so no two of these can be measured on one world.
  //
  // SO THE RUN GIVES EACH ONE A MOUNTED HOST OF ITS OWN: `lib/world-invocations.mjs` derives the split from this
  // flag, and `run.mjs` pays for a `cleanup` + `launch` + `capture` per world-owning driver. The launch-chain
  // driver above runs FIRST on that mount, because it is the only driver that brings a world to
  // `attachment=attached` (`capture/w-game-launch.cjs` `driveCabinHandoff`): measured 2026-11-22 (lane YZOWN,
  // `.tmp/lane-yzown.md`), a state driver alone on a fresh mount presses the launch control and the launch
  // settles at `instance=running/attachment=none` after 307s and never attaches.
  //
  // A hand-run stepwise invocation that puts two of them on one mount still cannot split itself, and the second
  // one says `not_measured: world_not_owned_by_this_driver` by name (`capture/game-states-verdict.mjs`) instead of
  // reporting the product defect `instance_status_never_running` for the run's own ordering - measured 2026-11-22,
  // `.tmp/livenow-r28.log:5202,5264`.
  { key: "x-game-death", file: "x-game-death.cjs", out: "x-game-death.txt", requiresGame: true, ownWorld: true },
  { key: "y-game-endgame", file: "y-game-endgame.cjs", out: "y-game-endgame.txt", requiresGame: true, ownWorld: true },
  {
    key: "z-game-disconnect",
    file: "z-game-disconnect.cjs",
    out: "z-game-disconnect.txt",
    requiresGame: true,
    ownWorld: true,
  },
]);
