# A Body Program journal, frozen

This directory holds two different things that used to be one file, and the difference is why the file was
permanently dirty:

- **`sample-2026-11-15.json` is a frozen measurement.** It is the exact bytes this repository had committed for the
  Mod's own journal (sha256 `38246d9dbaf9ccbfb91fa1a303b9766f0f17ebdbee6cb8d2e46ec7cd6264c387`, 510544 bytes,
  `schemaVersion: 3`). Nothing regenerates it: a run that writes a fresher journal must add a new dated sample beside
  it rather than overwrite it, because a sample rewritten by every run is the live output again under another name.
  `host/src/body-program-for-each.test.ts` names this file as the journal's document form; the refusal it measures
  (`for_each_where_unrecognised:in`) came from a live run, and this sample is another run's document - the sample is
  cited for what it is, never as the file that carried that code.
- **`journal.json` and `.journal.lock` are live output** and are git-ignored. They are a copy of one Mod journal scope
  directory (`<Constants.DataPath>/BodyProgramJournal-v1/stardew/<saveId>/<worldId>/<playerId>/<companionId>/`, see
  `integrations/stardew/WindowsBodyProgramJournalStore.cs`), which is why the lease file `.journal.lock` sits beside
  the journal. Copying a live scope in here is a read, not an authoring step: the file it overwrites is output, and
  git never sees it.

Never commit a live journal: if a run's journal is the evidence, freeze it under
`sample-<yyyy-mm-dd>.json` and cite that path.
