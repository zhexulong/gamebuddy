# A Body Program journal, frozen

This directory holds the frozen measurement, and nowhere else. The live journal a run harvests lives in
`tools/body-program-journal/`, and the two are separate directories because a run DELETES that one.

- **`sample-2026-11-15.json` is a frozen measurement.** It is the exact bytes this repository had committed for the
  Mod's own journal (sha256 `38246d9dbaf9ccbfb91fa1a303b9766f0f17ebdbee6cb8d2e46ec7cd6264c387`, 510544 bytes,
  `schemaVersion: 3`). Nothing regenerates it: a run that writes a fresher journal must add a new dated sample beside
  it rather than overwrite it, because a sample rewritten by every run is the live output again under another name.
  `host/src/body-program-for-each.test.ts` names this file as the journal's document form; the refusal it measures
  (`for_each_where_unrecognised:in`) came from a live run, and this sample is another run's document - the sample is
  cited for what it is, never as the file that carried that code.
- **`tools/body-program-journal/` is a run's output, not source.** It holds `journal.json` alone: a copy of one Mod
  journal scope directory
  (`<Constants.DataPath>/BodyProgramJournal-v1/stardew/<saveId>/<worldId>/<playerId>/<companionId>/`, see
  `integrations/stardew/WindowsBodyProgramJournalStore.cs`), made by `archiveBodyProgramJournal` in
  `tools/lib/stardew-native-local-player-fixture.mjs`, which removes that whole directory (`rm`, recursive) and copies
  the journal in. A run's evidence root is `<repo>/tools` (`launch-ladder-live.mjs` writes its result file there and
  hands `dirname(resultPath)` to `restore`), which is why the copy lives here.
- **The scope's lease (`.journal.lock`) is NOT copied**, and the marker's
  `lease: "present" | "absent" | "not_scoped"` says what the live scope held when the archive was taken. The lease is a
  retained handle its Mod process owns and the operating system releases when that process dies; the file is zero bytes
  with no pid, no owner and no time inside, so a copy carries nothing - it only reads as a lock somebody has to clear,
  which is what it was taken for on 2026-11-21 (a seven-minute stall read as a hang behind a file nothing held). Both
  names stay git-ignored here as a safety net for a scope copied by hand.

The sample used to sit in that wiped directory, so every run deleted it and left the live pair in its place - measured
2026-11-15, three times in one day, each time visible only as `D` on two paths in `git status`. A measurement stored
inside a directory something deletes is not a measurement.

Never commit a live journal: if a run's journal is the evidence, freeze it here as `sample-<yyyy-mm-dd>.json` and cite
that path.
