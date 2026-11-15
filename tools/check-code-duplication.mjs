#!/usr/bin/env node
/**
 * Duplication is a gate, not a percentage: one block of >= 40 tokens appearing at >= 3 sites fails, whatever share
 * of the tree that is - unless the block is a DECLARATION rather than an implementation (see FACADE below).
 *
 * WHY. `jscpd` has been a dependency with a `jscpd.json` config since the config was written and nothing ever
 * prevented anything: its `exitCode` was 0, its `format` was `javascript`/`typescript` so the C# Mod was never
 * tokenised, its paths omitted `integrations/stardew`, and no rung, script or workflow invoked it - a report nobody
 * ran. Meanwhile the largest real family in this tree is the eight-step admission pipeline repeated under 24
 * different method names (`receiptsByRequestId.TryGetValue` -> `this.revision++` -> `Guid.NewGuid` -> `nowMs` ->
 * `AdmitExecution(...)` -> the handler call -> `RememberTerminal(...)`), spread over
 * `integrations/stardew/farmhandexecutioncontroller.*.cs`. A percentage threshold cannot see it: measured on this
 * tree, the duplicated lines are 7.7% of the total and the duplicated tokens 9.3%, and 9.3% is a number nobody fails a
 * build over - which is why the rule below has no percentage in it.
 *
 * FACADE: TWO FACTS WORE ONE NAME. A group above the threshold is one of two different things, and counting them
 * together is what made the honest fix unrecordable:
 *
 *   - DUPLICATION - the same implementation text at N sites. It is removable, and removing it must lower the count.
 *   - FACADE - a declaration at N sites: the signature and parameter list of one method per catalogue entry, plus the
 *     one delegation that head performs. `RequestLocalPlantSeed`, `RequestLocalClearCask`, `RequestLocalPickupForage`
 *     ... are the same envelope because the game action catalogue gives them the same envelope; folding 46 actions
 *     into one generic dispatcher would delete the product, not the repetition. Nothing here is copied logic.
 *
 * MEASURED, 2026-11-12, over the 46 `farmhandexecutioncontroller*.cs` partials at HEAD (7fe2d52e), at this file's
 * thresholds: 39 groups. Folding the eight-step pipeline behind one admission seam at 57 sites gave 27 - but not as
 * "twelve fewer": 24 groups disappeared and 12 appeared, of which 6 are
 * `public LocalExecutionReceipt RequestLocal<Action>(...)` followed by `{` and the one `AdmitLocalExecution(...)`
 * delegation. The duplication was removed and the count went the wrong way, because the window had shifted onto the
 * signature. The same run is the falsifier for the alternatives:
 *
 *   - `--mode strict` (no identifier normalisation) reads 43 groups before the seam and 35 after - WORSE on the
 *     facade, because the facade's identifiers are identical and survive normalisation either way; and it STOPS
 *     catching 34 of the 39 groups that exist today, which is exactly the renamed-but-identical body this gate exists
 *     for (the per-action handler call, the per-site `RememberTerminal`, the per-tool refusal). Strict mode answers
 *     the opposite question to the one asked here.
 *   - an ignore pattern cannot express it: jscpd's `--ignore-pattern` skips matching TOKENS, so it would have to name
 *     the seam, the profile and every parameter - one spelling per call site, which is the drift this gate refuses.
 *
 * SO THE RULE IS `isFacadeOnly(fragment)`, evaluated on the text jscpd matched, and it fails CLOSED: a fragment is a
 * facade only while EVERY non-blank, non-comment line of it is declaration text (a signature or a parameter, naming no
 * value: no literal, no spread, no assignment), a brace, a delegation (`return <identifier>;` or
 * `if (<condition>) return <identifier>;`) or a pass-through read (`Type name = a.b.c;`). One lookup, one minted
 * receipt, one comparison, one second branch, one string - anything the rule does not positively recognise - keeps the
 * group as duplication. The fragment must also contain at least one declaration line, so a window that begins inside a
 * body is never a facade. What that releases today is measured, not asserted: on this tree it is exactly one group,
 * `2a848276806f` at 3 sites / 71 tokens, the recursive parameter list of `ClearingPlanner`; on the pre-seam controllers
 * it is none of the 39. What it would release and should not: a method head whose only statement is a single admission
 * guard, even when that guard is an inline `receiptsByRequestId.TryGetValue` rather than a seam call - the rule cannot
 * tell those two apart, and it is safe to be blind to them because the family the gate exists for is five statements
 * of lookup, `revision++`, `Guid.NewGuid`, `nowMs` and the guard, not one.
 *
 * THE GUARD-FIRST ADMISSION PREAMBLE: FIVE GROUPS COUNTED HERE, AND THE EXTRACTION THAT OWES THEM. Measured 2026-11-12
 * at e1ca02df, after `ef4f82ae` folded the eight-step preamble behind `BeginLocalExecution`/`AdmitLocalExecution`: the
 * five groups below are ONE family, not five copies - the guard-first preamble every action that must refuse a
 * non-scope-bound caller BEFORE it reads the world. Its shape is a signature envelope, the delegation to
 * `BeginLocalExecution` (or to `AdmitLocalExecution` where admission comes first), the `TryGetBoundActor` refusal, the
 * `world_not_ready` refusal, and then the action's own first check:
 *
 *   14f58a9d0c3f  100 tokens / 3 sites  ClearDebris, FeedAnimal, CollectAnimalProduct
 *   4334a6a5ca04  162 tokens / 3 sites  WaterCrop, HarvestCrop, PlantSeed
 *   442859664d14  113 tokens / 4 sites  PlantSeed, PlaceWoodFence, PlaceCrabPot, BaitCrabPot
 *   9b9454fa5db9  128 tokens / 6 sites  WaterCrop, InspectMachine, PetAnimal, InspectNpcRelationship,
 *                                         DoorTransition, TillSoil
 *   e8ea671008f4   51 tokens / 5 sites  TakePedestalItem, ToggleFenceGate, HarvestBush, HarvestFruitTree, ShakeTree
 *
 * They are DUPLICATION and not a facade, and the rule's own case for that is what decides it: each one carries
 * `return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null)` - a call
 * with a literal argument, which the facade reader above deliberately keeps counted, together with the branch chain
 * that precedes it. Widening `isFacadeOnly` to release them would release exactly the shape the paragraph above says
 * it must stay blind to, so the rule is NOT the thing to change. They are not new copies either: the text is the same
 * text the old admission-pipeline families contained - removing the pipeline from the window made these runs maximum.
 *
 * THE FIX IS A FURTHER SEAM IN THE CONTROLLERS AND IT IS OWED, not waived. Folding `BeginLocalExecution` plus the
 * `TryGetBoundActor` and `world_not_ready` refusals into one call is the same move `ef4f82ae` made for the 62 actions
 * whose checks come after admission, applied to the actions whose checks come before it; it removes all five groups
 * and it is a change to `integrations/stardew/farmhandexecutioncontroller.*.cs`, which no lane may make while the
 * receipt-store extraction owns those partials. Until it lands these five stay `clone_group` findings and
 * `--write-baseline` stays refused, which is why the ratchet reads `new 5` rather than `new 0` - the baseline is not
 * allowed to record them, and recording them would be recording the residue of a refactor as debt.
 *
 * THE UNIT: THE FLOOR OF THE LANGUAGE IS NOT DEBT, AND COUNTING IT WAS THE DEFECT. Measured 2026-11-15 at `0dce992a`:
 * `clone groups 291 · duplication 286 · new 47 · grown 4` sat red for hours and every lane answered it with "predates
 * this lane", which the gate accepted because the finding named no owner. The unit was wrong underneath that: the
 * group that grew was `import path from "node:path"` at 4 sites, and it grew because a lane ADDED A GATE FILE that
 * imports `node:path` - so the metric counted correct engineering as debt, and 286 "duplications" was not 286
 * problems. The same reading held `reasonCode: String(error instanceof Error ? ...)` (4 sites) and `evidence,` (4
 * sites), both the shape every runner's terminal is written in.
 *
 * So the population is SPLIT, and only one half can fail. The classification is derived from the matched text itself -
 * never from a list of paths - by one question: does the match contain a BLOCK OF STATEMENTS?
 *
 *   - SYNTAX FLOOR - no. A module preamble (`import ... from`), a parameter or property list, a literal's members,
 *     brace and paren closers, one single-line statement, an error shaped by one line. Every file of a kind carries
 *     this text because the language gives it no other spelling. Counted, printed, never a finding, never recorded.
 *   - STRUCTURAL - yes. A function body, a handler body, a multi-statement block: text that a reader can fold behind
 *     one seam and that a third copy of is real debt. This is the population the ratchet governs.
 *   - FACADE - the existing declaration reading, above, which still wins: a catalogue envelope is neither of these.
 *
 * `hasStatementBlock` is the whole rule: literals and comments are blanked (a brace inside a message is not a block),
 * then every `;` inside a brace marks that brace as a statement block when the text since the previous separator does
 * work rather than naming a member - `return x;` and `const y = f();` mark it, `messageId: string;` and `int slot,`
 * do not. A brace still open at the window's end counts too: jscpd's window ends where the match ends, and a window
 * that opens a body and is cut off has still matched that body's statements.
 *
 * Measured on this tree at `0dce992a` over the 291 counted groups: syntax floor 131 groups / 578 sites, structural
 * 155 groups / 714 sites, facade 5. The 4 `clone_group_grew` findings and 30 of the 47 `new` ones were floor; the
 * structural residue is the runner family the debt line already names plus the guard-first controller preambles the
 * paragraph above already owes.
 *
 * ATTRIBUTION, so "predates this lane" is a hash a reader can check. Every finding names the last commit that touched
 * the file holding its most recent site (`git log -1 --format=... -- <file>`, cached per file), and `--residuals` names
 * it for every structural group the ratchet carries. It is a FILE-LEVEL reading and says so: `git blame` on this tree
 * costs 0.2-0.7s a call, which a gate that runs on every commit cannot pay per site. A file no commit holds reads
 * `unrecorded`, which is the fact a lane's in-flight work shows and a committed one does not.
 *
 * THE CEILING THAT ONLY FALLS IS NOT IN THIS UNIT, AND THE RED IT WOULD HIDE IS NAMED HERE INSTEAD. The split makes most
 * of the red disappear by classifying it; the structural residue that predates the split is real debt no lane in flight
 * owns, and this change does NOT record it. So the tree reads `new 33 · grown 3` after `--record-shrinks` and the gate
 * stays red on exactly those 36 groups, each with the commit behind it - which is the honest reading, and the next unit
 * is the one that records a ceiling per group and only ever lowers it. Recording them here would have meant a write that
 * may ADD to a ratchet, which is the power this file spends a section refusing.
 * THE RESIDUAL AT `38629989`, ENUMERATED: THIRTY-SIX GROUPS, FOUR CAUSES, AND THE OWNER OF EACH. The paragraph above says
 * the 36 are real and owed; this table says WHICH 36 and who owes each, so the next lane does not re-derive it. It is a
 * dated snapshot - the live reading is `--residuals`, which recomputes the newest site and its commit on every run - and
 * the group ids are `groupHash` values a reader can match against `--residuals` output byte for byte. Sites and tokens are
 * this run's; the commit is the one that last touched the file holding the group's most recent site.
 *
 *   C  controller partials (`integrations/stardew/farmhandexecutioncontroller.*.cs`) - 6 groups. One cause: the per-action
 *      method body re-spells the admission preamble and its own postcondition verdict. The fix is the guard-first seam the
 *      header already owes, in partials the receipt-store extraction owns; no lane outside that one may edit them.
 *   R  the native-local runner family (`tools/run-stardew-native-local-player-*-smoke.mjs`) - 22 groups. One cause: each
 *      runner still hand-writes the tail the L1 extraction is retiring (evidence parsing, the fixture-config refusal, the
 *      `if (import.meta.main)` block). The owning primitive is `tools/lib/native-local-runner-*`, which another lane owns.
 *   T  `tools/` itself - 7 groups, and these are this file's own neighbourhood: the `fail` helper five gates re-spell, a
 *      `readSource` helper, the argv-root preamble, the C# declaration-body locator, the migrator's three phases and the
 *      JSONL reader the A/B live runner and the cost reader both carry. Extractable here; see the declarations file.
 *   H  `host/src/` - 1 group. `};` closing the same three-store shape; the Host lane owns it.
 *
 *   0804dfdde884   4 sites  40 tokens  integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs:69  a3096aca 2026-11-15  refactor(stardew): 3,869 comment lines the code a...
 *   18082b2d8aae   3 sites 109 tokens  integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs:685  a3096aca 2026-11-15  refactor(stardew): 3,869 comment lines the code a...
 *   5745550f7028   3 sites  79 tokens  integrations/stardew/farmhandexecutioncontroller.modalactions.cs:71  a3096aca 2026-11-15  refactor(stardew): 3,869 comment lines the code a...
 *   72fc77528444   5 sites 128 tokens  integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs:685  a3096aca 2026-11-15  refactor(stardew): 3,869 comment lines the code a...
 *   b0f8d2962c80   5 sites  48 tokens  integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs:996  a3096aca 2026-11-15  refactor(stardew): 3,869 comment lines the code a...
 *   ebd20901d6dd   3 sites  94 tokens  integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs:685  a3096aca 2026-11-15  refactor(stardew): 3,869 comment lines the code a...
 *   0ba836ed5f28   6 sites  72 tokens  tools/run-stardew-native-local-player-fertilize-tile-smoke.mjs:311  fc303394 2026-11-15  L1 batch 3: the tile predicates and the slot rule...
 *   26572fedd8b4   6 sites  43 tokens  tools/run-stardew-native-local-player-fish-here-smoke.mjs:579  33764015 2026-11-15  L1 batch 2: the evidence parser, deleted from the...
 *   2ed6e2789074   3 sites 156 tokens  tools/run-stardew-native-local-player-harvest-inventory-full-recovery-chain-smoke.mjs:618  fc303394 2026-11-15  L1 batch 3: the tile predicates and the slot rule...
 *   36fc0ca1faad   5 sites  44 tokens  tools/run-stardew-native-local-player-chest-retrieve-smoke.mjs:119  8386f1ac 2026-11-15  L1 batch 4: the aliases - `parseStrictEvidence` h...
 *   41b6a9a0ee14  12 sites  52 tokens  tools/run-stardew-native-local-player-break-container-source-smoke.mjs:316  c5e79ad1 2026-11-15  L1 batch 1: the slab the template was extracted f...
 *   4979a64a0bf7  11 sites  42 tokens  tools/run-stardew-native-local-player-advance-day-smoke.mjs:115  8386f1ac 2026-11-15  L1 batch 4: the aliases - `parseStrictEvidence` h...
 *   51337c58ae5e   4 sites  53 tokens  tools/run-stardew-native-local-player-chop-tree-source-smoke.mjs:33  f633e28f 2026-11-15  refactor(stardew): six more runners stop spelling...
 *   54032cab30fd   4 sites  77 tokens  tools/run-stardew-native-local-player-fertilize-tile-smoke.mjs:125  fc303394 2026-11-15  L1 batch 3: the tile predicates and the slot rule...  [GREW]
 *   54f5045b81ca   3 sites  86 tokens  tools/run-stardew-native-local-player-claim-mail-attachment-smoke.mjs:202  33764015 2026-11-15  L1 batch 2: the evidence parser, deleted from the...
 *   5e82f92b30fd  11 sites  50 tokens  tools/run-stardew-native-local-player-break-container-source-smoke.mjs:43  c5e79ad1 2026-11-15  L1 batch 1: the slab the template was extracted f...
 *   667e632dbd8e   5 sites 168 tokens  tools/run-stardew-native-local-player-chop-stump-smoke.mjs:84  8386f1ac 2026-11-15  L1 batch 4: the aliases - `parseStrictEvidence` h...
 *   866bce1db3c2   3 sites 102 tokens  tools/run-stardew-native-local-player-wia-modal-dismiss-chain-smoke.mjs:357  f633e28f 2026-11-15  refactor(stardew): six more runners stop spelling...
 *   8d7cbc002d5b   3 sites  42 tokens  tools/run-stardew-native-local-player-break-resource-clump-smoke.mjs:243  8386f1ac 2026-11-15  L1 batch 4: the aliases - `parseStrictEvidence` h...
 *   98fca398edd9   3 sites  73 tokens  tools/run-stardew-native-local-player-wia-answer-question-smoke.mjs:52  f633e28f 2026-11-15  refactor(stardew): six more runners stop spelling...
 *   a573ecdd12e1  79 sites  49 tokens  tools/run-stardew-native-local-player-advance-day-smoke.mjs:122  8386f1ac 2026-11-15  L1 batch 4: the aliases - `parseStrictEvidence` h...
 *   abb765138e86   3 sites  69 tokens  tools/run-stardew-native-local-player-enter-mine-smoke.mjs:72  9942bf38 2026-11-14  Revert "contracts(stardew): three runners retire ...
 *   b8f3ebe8b8c8   8 sites  83 tokens  tools/run-stardew-native-local-player-enter-exit-smoke.mjs:610  0b875a3f 2026-11-15  refactor(stardew): eight runners stop spelling th...
 *   bd38a6981159   5 sites  43 tokens  tools/run-stardew-native-local-player-chop-tree-source-smoke.mjs:39  f633e28f 2026-11-15  refactor(stardew): six more runners stop spelling...
 *   c865fd79ddcb   4 sites  67 tokens  tools/run-stardew-native-local-player-claim-mail-attachment-smoke.mjs:155  33764015 2026-11-15  L1 batch 2: the evidence parser, deleted from the...  [GREW]
 *   dbfd66005ada   3 sites  43 tokens  tools/run-stardew-native-local-player-interact-npc-with-item-smoke.mjs:348  8386f1ac 2026-11-15  L1 batch 4: the aliases - `parseStrictEvidence` h...
 *   f5abe50285a4   4 sites  47 tokens  tools/run-stardew-native-local-player-clear-cask-smoke.mjs:108  8386f1ac 2026-11-15  L1 batch 4: the aliases - `parseStrictEvidence` h...
 *   fa794682dc27   3 sites 791 tokens  tools/run-stardew-native-local-player-wia-answer-question-smoke.mjs:183  f633e28f 2026-11-15  refactor(stardew): six more runners stop spelling...
 *   0d289c187367   3 sites  88 tokens  tools/audit-stardew-clearing-vocabulary.mjs:100  1228653d 2026-11-15  chore(tools): the clearing-vocabulary gate satisf...
 *   302a3e0fd799   5 sites  51 tokens  tools/check-browser-state-projection-fields.mjs:370  cb649f6d 2026-11-15  feat(game-browser): the capability summary is the...  [GREW]
 *   37d30948c28c   5 sites  40 tokens  tools/check-engine-affordance-census.mjs:252  302af903 2026-11-14  feat(tools): 145 gate files declare their domain,...
 *   6f12b0c52e35   3 sites  48 tokens  tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs:1313  b9064533 2026-11-15  the night watch wakes on the world's statements, ...
 *   8048817a816d   3 sites  44 tokens  tools/check-browser-state-projection-fields.mjs:108  cb649f6d 2026-11-15  feat(game-browser): the capability summary is the...
 *   b4a64ebbcbf0   3 sites  46 tokens  tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs:1520  b9064533 2026-11-15  the night watch wakes on the world's statements, ...
 *   d34e7372ee12   3 sites  73 tokens  tools/migrate-runner-to-template.mjs:147  0b875a3f 2026-11-15  refactor(stardew): eight runners stop spelling th...
 *   6b4320dbe568   3 sites  62 tokens  host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts:1340  9e209214 2026-11-15  the pump's fact producers are a declared set, and...
 *
 * THE DECLARATION DOOR, AND WHY IT IS NOT THE BASELINE WEARING A SECOND NAME. The paragraph above says the residue is
 * owed and that recording it in the baseline would be banking another lane's refactor as debt. The residue is still
 * unowned by any READER, though: `new 29` names a hash and a commit and leaves the question "is anyone going to fix
 * this?" to whoever is holding the tree. So `tools/duplicate-code-declarations.json` records the groups whose fix is
 * owned by a lane this one may not edit, and it records them with three facts the baseline cannot hold - an OWNER, a
 * REASON, and an EXPIRY. What it is not:
 *
 *   - not a reclassification. A declared group stays STRUCTURAL, stays in `duplication`, stays in its sites total and is
 *     printed one line per run (`declared:<hash>: ... · <owner> · <reason> :: <first line>`). The census reads
 *     `duplication 165 (741 sites) · declared 29`, so the door can never hide what walked through it;
 *   - not a ratchet entry. Nothing writes this file but a hand: `--write-baseline` records the UNDECLARED population and
 *     says how many declared groups it left out, and `--record-shrinks` does not read it at all. A lane that wants its
 *     own new duplication accepted has nowhere to put it, because the file is not a write target;
 *   - not a growth licence. An entry declares a SITE COUNT, and a declared group that gains a site is `clone_group_grew`
 *     like any other - the one thing a declaration may never do is buy the copy that arrives tomorrow;
 *   - not permanent. A group that SHRANK, or that left the duplication population (fixed, or now read as the floor or a
 *     facade), turns its entry into `stale_clone_declaration`, which fails the gate and names the entry to delete. An
 *     exemption that outlives its cause is the defect this whole family of gates exists for, so the expiry is a finding
 *     and not a comment.
 *
 * The reason is the load-bearing field, and the gate can only check that it is a sentence. An entry that says "historical"
 * or "predates this lane" is refused by review and by the note in the file itself; what an entry may say is which text
 * the copies share, which lane owns folding them, and why that lane is not this one. Measured 2026-11-15 at `38629989`:
 * 29 entries - 6 controller partials the receipt-store extraction holds, 22 native-local runners the L1 extraction holds,
 * 1 Host store shape - and the 7 `tools/` groups in that same reading are NOT declared, because this lane can extract
 * them and a declaration there would be a fix it declined to make.
 *
 *   6. a group DECLARED in `tools/duplicate-code-declarations.json` at the same site count passes and is printed with its
 *      owner and reason; one that gained a site is `clone_group_grew`, one that lost a site or left the population is
 *      `stale_clone_declaration` (THE DECLARATION DOOR, above).
 *
 * WHAT IT ASSERTS, per clone group - the sites jscpd reports for one repeated text, grouped by that text:
 *
 *   1. a STRUCTURAL group with >= MIN_TOKENS tokens at >= MIN_SITES sites is a finding, named with EVERY site, the
 *      group's first line of code, and the commit that last touched its most recent site, so the reader recognises the
 *      block and checks the owner without opening the report;
 *   2. a group recorded in `tools/duplicate-code-baseline.json` at the same or a smaller size passes, because that
 *      duplication already existed when the baseline was written;
 *   3. a baselined group that gained a SITE is a finding (`clone_group_grew`), and one that lost one is a finding too
 *      (`stale_clone_baseline`): the baseline can only shrink, so a fix has to be recorded rather than silently
 *      leaving an entry behind;
 *   4. a FACADE group is counted and printed (`facade-only:<hash>: ...`) and is not a finding, because there is no
 *      change a reader could make in response; a baseline entry that records one is `facade_only_clone_baselined`,
 *      which is a different fact from `stale_clone_baseline` and says so - an entry for a group the tree still has,
 *      under a name that no longer claims it is duplication;
 *   5. a SYNTAX FLOOR group is counted and printed in the census with its groups and sites and is not a finding, for
 *      the same reason; a baseline entry that records one is `syntax_floor_clone_baselined`, and `--record-shrinks`
 *      deletes it, because the record claims debt the split does not agree is debt.
 *
 * THE TOKEN COUNT IS PUBLISHED, NOT RATCHETED, BECAUSE IT CANNOT HOLD STILL. A group's identity is `groupHash` of
 * `fragment`, which is the FIRST site's source slice from the match's start line to its end line; the `tokens` jscpd
 * reports is per PAIR, and grouping keeps `max` over the pairs. Those are two different granularities of one match, so
 * the number can move while the text cannot: at a hash that matches a recorded entry, the fragment is the same bytes by
 * construction, and what changed is how far the run matched WITHIN that slice against the other sites. Measured on one
 * run of this tree: of 2191 fragment groups, 100 carry more than one pair token count (`269d6807cfe7` reads 45 and 40
 * over its three pairs). Measured on real history: `9b99db60ab88` is recorded at 91 tokens and measures 97 today while
 * its fragment hashes to the recorded hash, so the record and the tree describe the same text and disagree about it.
 * A monotone ratchet cannot hold a quantity that moves in both directions without the thing it measures moving, and
 * recording 91 -> 97 would be growing a record in the face of no new copy - so growth is decided by the site count, and
 * a token reading that differs from the record is published as `token_count_unstable:<hash>: <a> -> <b> tokens at N
 * sites` and does not fail the gate. Nothing is lost by that: a LONGER copied block moves the fragment's end line, so it
 * arrives as a different hash, which is an unrecorded `clone_group` and fails; a block copied MORE times arrives as a
 * site, which is `clone_group_grew` and fails. The token count stays in the baseline as the reading `--write-baseline`
 * refreshes, so a reader can still see how much of a window actually matched.
 *
 * THE POPULATION IS THE INDEX, NOT THE DIRECTORY. jscpd walks the working tree, so a file a lane has written but not
 * staged is measured as if it were repository content - and on 2026-11-12 one was: `tools/check-test-await-deadlines.mjs`
 * sat untracked in a shared checkout, cloned the `node:fs`/`node:path`/`node:url` preamble three tracked `tools/*.mjs`
 * scripts already carry, and made the baselined group `269d6807cfe7` read `3 -> 4 sites`. Every lane's new file would
 * then move somebody else's ratchet, and a baseline entry could name a path no commit holds. So the pair population is
 * filtered to files git has in the index (`git ls-files --others --exclude-standard` names the complement), and what
 * was dropped is published rather than silently excluded: `untracked_not_counted N` counts the distinct files removed
 * from the comparison. Nothing dropped prints nothing; something dropped says so. A tree that is not a git work tree
 * has no index to be outside of, so that reading is `blocked` with `git_index_unreadable:<root>` instead of being
 * widened to whatever is on disk - this gate's own fixtures are `git init`ed for the same reason.
 *
 * THE POPULATION IS PRINTED THREE WAYS, so none of the facts can hide inside another: `clone groups N · of which
 * facade-only M · syntax-floor A (B sites) · duplication K (L sites)`. K is the structural population the ratchet
 * governs and what `--write-baseline` records, L is its sites; a new or grown structural group still fails, which is
 * the hard failure this file always had. A is printed with its site count and decides nothing - a reader can see how
 * much of the match population the split classified as the floor and disagree with the rule in one place.
 *
 * THE DEBT IS PRINTED IN ITS OWN UNIT, because `duplication 289` was read as 289 groups, 289 sites and 289 lines by
 * three readers of one line, and only one of those readings is right. One line follows the census:
 *
 *   debt: <baselined groups> groups · <baselined sites> sites · of which runners <M> groups / <N> sites
 *
 * The groups are the duplication groups the baseline records AND the tree still has - the debt the ratchet carries,
 * which `--record-shrinks` can only lower - and the count beside them is those groups' SITES, which is the unit of the
 * thing being duplicated: the number falls by one when one copy of a group is deleted, and by that group's whole site
 * count when it drops below the rule and leaves the population, so a reader can subtract what they removed instead of
 * guessing what a group weighs. Measured 2026-11-15 at `eaa5f5a6` over the 283 recorded entries:
 * `250 groups · 1041 sites · of which runners 107 groups / 467 sites` - nearly half of the recorded debt is one family,
 * the `run-stardew-native-local-*` smoke runners the L1 extraction is already retiring, and the bare `duplication 289`
 * could not say so. That family is why this line exists: a red number nobody can place in the tree is read as weather.
 *
 * WHAT COUNTS AS A RUNNER IS NOT A LIST KEPT HERE. It is `RUNNER_FILE` - the family `check-native-local-runner-scaffold.mjs`
 * owns, scans and ratchets - tested against a site's basename under `tools/`, so the runner written tomorrow is counted
 * the moment it exists and a family member renamed out of the rule stops being counted instead of being remembered. A
 * group is a runner group when ANY of its sites is a runner, because that copy is one of the copies that has to go before
 * the group can leave the population; the site count beside it is the runner sites alone, so `467 of 1041` is a share of
 * one unit and not a group count smuggled into a site count.
 *
 * A BLOCKED READING HAS NO DEBT, and says so (`debt: not measured · <reason>`) rather than printing `0 groups`, which
 * would be the same defect this line exists to end: a zero that means "nothing to do" beside a zero that means "nothing
 * was measured". The line is a REPORT and changes no verdict: `new` and `grown` still fail, `--write-baseline` still
 * refuses, `--record-shrinks` still only lowers.
 *
 * THE CLI TAKES `--root <dir>` so the two writes above can be proved against a throwaway tree by this file's own suite -
 * the same fixture door `check-cognitive-complexity.mjs` has. It moves where the baseline and `jscpd.json` are read from
 * and written to, never what the rule is; `jscpd` itself still resolves from THIS file, so a fixture is measured by the
 * repository's own scanner.
 *
 * THE BASELINE IS A RATCHET, NOT AN ACCEPT LIST, AND ITS TWO WRITES HAVE DIFFERENT POWERS. `--write-baseline` may ADD a
 * group - that is how the tree is first written down - but only while the file does not exist or nothing is new or grew,
 * so a green run never becomes the way to accept new duplication. `--record-shrinks` may only move an existing record
 * DOWN: the entry of a group that left the duplication population is deleted, the entry of a group that survived with
 * FEWER sites is lowered onto the tree's sites, and every other entry is left byte-identical - it can never add a group
 * or raise one, which is what makes it safe to run on a tree that also carries somebody else's bad news. The second
 * power exists because a lane that removes a duplicate produces good news on a tree that almost always holds bad news
 * too, and a ratchet that can only be written when there is no bad news drifts from the tree until the next reader's
 * only satisfying move is deleting and re-creating the file. Measured
 * 2026-11-12 on this tree, which read `new 14 · grown 1 · stale 46`: `--record-shrinks` removed 39 entries and lowered
 * 7, and the same reading afterwards was `stale 0 · new 14 · grown 1 · duplication 314` - nothing banked in either
 * direction. DELETING a shrunken-but-extant entry instead of lowering it would turn that group into a `clone_group`
 * finding, which banks the loss of a record as new duplication; lowering is the only honest spelling of "this duplicate
 * now has 3 sites", and deleting is only for a group the tree no longer has. Line numbers in the baseline are
 * documentation; the comparisons are the site COUNT and, for growth, nothing else - a line inserted above a site must
 * not turn the gate red, and the token count is published rather than compared (above).
 *
 * THE POPULATION is this file's `SOURCE_TREES`, and `jscpd.json` must declare the same paths, formats, ignore list and
 * thresholds or `jscpd_config_disagrees:<field>` fails: two spellings of "what is examined" drift apart the first time
 * one of them is edited. `integrations/stardew` and `desktop` are here because they are this repository's C# sources,
 * and `csharp` is in the format list because dropping the tree that matters is the defect this gate exists for.
 *
 * jscpd SKIPS FILES GIT IGNORES (`scratch/`, `.tmp/`), and it exits 0 having examined nothing when a path resolves to
 * no file. So zero files, or a declared format with zero files, is `blocked` (exit 2) naming the format - never a pass.
 * `examined N` counts the files jscpd tokenised, so `0 findings` beside it means something.
 *
 * WHAT IT DOES NOT ASSERT: that a group below the rule is good code, that near-duplicates under 40 tokens matter, or
 * that two implementations of one idea share no line: jscpd matches token sequences, and a rename it normalises may
 * make two structurally identical bodies one group. What it refuses is the specific thing that shipped: the same
 * block copied a third time.
 *
 * red-proof: inject  a tree whose baseline records one group and whose fourth copy has landed ->
 *                    `node tools/check-code-duplication.mjs --root <fixture> --write-baseline` prints
 *                    `baseline_write_refused: 1 group(s) are new or grew - the baseline may only record a shrink`, exits 1
 *                    and leaves the baseline file byte-identical; the same fixture with its baseline deleted creates one
 *                    (`baseline_created`), and one whose tree shrank writes (`baseline_written`) - so the refusal is a
 *                    condition on the tree and not a refusal to write at all.
 * red-proof: inject  one recorded group at three runner sites beside a host file's own recorded group ->
 *                    `debt: 2 groups · 4 sites · of which runners 1 groups / 3 sites`
 *
 * red-proof: inject  a structural group at three sites with a matching declaration -> the census reads `declared 1` and
 *                    `new 0`, status `passed`, and `declared:<hash>: 3 sites at 50 tokens · <owner> · <reason> :: <first
 *                    line>` is printed; a fourth copy of the same text -> `clone_group_grew:<hash>: now 4 sites at 50
 *                    tokens, tools/duplicate-code-declarations.json declared 3 sites (<owner>)`; the same text at two
 *                    sites -> `stale_clone_declaration:<hash>`; an entry whose hash the tree does not have ->
 *                    `stale_clone_declaration:<hash>`; an entry with no `reason` ->
 *                    `duplicate_code_declarations_malformed:reason:<hash>`; and `--write-baseline` records the undeclared
 *                    population only, saying how many it left out.
 *
 * USAGE:
 *   node tools/check-code-duplication.mjs                   # the verdict; exit 1 on a new/grown/stale structural group
 *   node tools/check-code-duplication.mjs --record-shrinks   # delete and lower entries only; adds nothing
 *   node tools/check-code-duplication.mjs --write-baseline   # write the tree down; refuses while a group is new or grew
 *   node tools/check-code-duplication.mjs --residuals        # every structural group with the commit behind its newest site
 *   node tools/check-code-duplication.mjs --root <dir>       # read and write the baseline of another tree (fixtures)
 *
 * red-proof: inject  a shared module preamble (`import path from "node:path"`) at three sites, no baseline ->
 *                    `clone groups 1 · of which facade-only 0 · syntax-floor 1 (3 sites) · duplication 0 (0 sites)`,
 *                    status `passed`; the same three files with one function body copied between them ->
 *                    `syntax-floor 0 · duplication 1 (3 sites)` and `clone_group:...tokens:3sites:` naming every site,
 *                    status `failed` - so the ratchet is red on a body and green on the floor (the falsifier).
 * red-proof: inject  a baseline that records a floor group -> `syntax_floor_clone_baselined:<hash>`, status `failed`,
 *                    and `--record-shrinks` deletes that entry (`removed 1`) while adding nothing.
 * red-proof: inject  a tree whose three copies are committed -> the finding carries `attribution.commit`,
 *                    `attribution.date` and the commit subject beside its `detail`; the same tree with no commit ->
 *                    `unrecorded (no commit holds <file>)` and the verdict is unchanged.
 *
 * red-proof: inject  a fourth copy of the admission pipeline body into a `farmhandexecutioncontroller.*.cs` partial
 *                    while that group's baseline entry stays at its recorded site count ->
 *                    `clone_group_grew:99908b2b6e7b: now 24 sites at 67 tokens, the baseline recorded 23` naming every
 *                    site; with today's baseline removed, the same group reads
 *                    `clone_group:64tokens:9sites: integrations/stardew/farmhandexecutioncontroller.<each partial>.cs`
 *                    beside `files examined 1270 · clone groups 354 · new 354`; an entry whose sites are gone ->
 *                    `stale_clone_baseline:<hash>`.
 * red-proof: inject  a baseline recording 4 sites beside a tree that now has 3 -> `--record-shrinks` prints
 *                    `shrinks recorded: 1 · removed 0 · nothing added`, the entry's site list is lowered to those 3, and
 *                    `stale_clone_baseline` is gone from the next reading; a group deleted from the tree entirely -> its
 *                    entry is removed and a later run never adds it back; a group that GREW -> its entry stays
 *                    byte-identical, `clone_group_grew` still fails the gate, and nothing is banked; no baseline file at
 *                    all -> `baseline_shrink_refused: there is no tools/duplicate-code-baseline.json to shrink`.
 * red-proof: inject  three controller partials whose methods share an envelope and one `AdmitLocalExecution(...)`
 *                    delegation, with no baseline -> `clone groups 1 · of which facade-only 1 · duplication 0`, status
 *                    `passed`, and `facade-only:<hash>: 3 sites at <n> tokens :: public LocalExecutionReceipt
 *                    RequestLocal<Action>(` printed; a genuine lookup -> `revision++` -> `Guid.NewGuid` -> `nowMs`
 *                    preamble injected into the same three methods -> `clone_group:<n>tokens:3sites:` ... status
 *                    `failed`, with `facade-only` unchanged; a baseline that records the facade group ->
 *                    `facade_only_clone_baselined:<hash>`.
 *
 * Every direction above is red on jscpd's own report, in tools/check-code-duplication.test.mjs, whose throwaway trees
 * are copied from the real body.
 */

export const gateDeclaration = {
  id: "check-code-duplication",
  domain: "arch",
  tier: "l2",
  kind: "ratchet",
};

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { RUNNER_FILE } from "./check-native-local-runner-scaffold.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "tools/duplicate-code-baseline.json";
const DECLARATIONS = "tools/duplicate-code-declarations.json";
const JSCPD_CONFIG = "jscpd.json";
const JSCPD_ENTRY = "jscpd/run-jscpd.js";

/** The rule, as three numbers: a block this long, repeated this many times, is a finding. */
export const MIN_TOKENS = 40;
export const MIN_SITES = 3;
export const MIN_LINES = 5;

/** The source trees this repository owns. Vendored, mounted (`ref/`, `design/`) and built trees are not ours. */
export const SOURCE_TREES = Object.freeze([
  "host/src",
  "host/scripts",
  "dialogue-web/src",
  "packages",
  "tools",
  "integrations/stardew",
  "desktop",
]);

/** What is not source of ours, or is a copy of it: build output, generated bundles, the decompiled game, tests. */
export const IGNORES = Object.freeze([
  "**/vendor/**",
  "**/ref/**",
  "**/tmp/**",
  "**/.worktrees/**",
  "**/dist*/**",
  "**/*.test.*",
  "**/node_modules/**",
  "**/.commit-validation/**",
  "**/tools/lib/**",
  "**/bin/**",
  "**/obj/**",
  "**/tests/**",
  "**/GameBuddy.Desktop.Tests/**",
]);

/** The formats this tree writes source in. `csharp` is why the Mod appears at all. */
export const FORMATS = Object.freeze(["javascript", "typescript", "csharp"]);

/** `E:\...` / `\\?\E:\...` / `a\b.cs` -> `a/b.cs`, relative to the tree that was examined. */
export function normaliseSitePath(name, root = REPO) {
  const absolute = name.replace(/^\\\\\?\\/u, "");
  const relative = path.isAbsolute(absolute) ? path.relative(root, absolute) : absolute;
  return relative.replaceAll("\\", "/");
}

/**
 * Is this site one of the native-local smoke runners - the family whose L1 extraction is the reason the debt line names
 * it? The predicate is the family's own (`RUNNER_FILE`, from the gate that owns, scans and ratchets those files), read
 * against the site's basename under `tools/`, so a runner added or renamed tomorrow is attributed without an edit here.
 */
export function isRunnerSite(file) {
  return file.startsWith("tools/") && RUNNER_FILE.test(path.basename(file));
}

/** The identity of a clone group: the text jscpd matched, hashed so a baseline line stays readable. */
export function groupHash(fragment) {
  return createHash("sha256").update(fragment).digest("hex").slice(0, 12);
}

const compareSites = (left, right) => left.file.localeCompare(right.file) || left.line - right.line;

/** Statements and declarations, told apart by the only thing a token report cannot tell us: the source text. */
const CONTROL_HEADS = /^(if|else|for|foreach|while|switch|using|lock|catch|try|finally|do|case|default)\b/u;
const NAMES_NO_VALUE = /["'`]|\d|\s=\s|\s=/u;
const isBrace = (line) => line === "{" || line === "}";
const isDeclaration = (line) =>
  !(/[;={}]/u.test(line) || NAMES_NO_VALUE.test(line) || line.includes("...") || CONTROL_HEADS.test(line)) &&
  (line.includes("(") || /[),]$/u.test(line));

/**
 * A fragment is a sequence of units: declaration text, braces, and statements (a control head and its body joined to
 * the line that closes it). Nothing here parses a language; it separates the two kinds of line a clone window can be
 * made of, which is all the facade rule needs.
 */
export function fragmentUnits(fragment) {
  const lines = fragment
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
  const units = [];
  let pending = null;
  for (const line of lines) {
    if (pending === null && isBrace(line)) {
      units.push({ kind: "brace", text: line });
      continue;
    }
    if (pending === null && isDeclaration(line)) {
      units.push({ kind: "declaration", text: line });
      continue;
    }
    pending = pending === null ? line : `${pending} ${line}`;
    if (/[;{]$/u.test(line)) {
      units.push({ kind: "statement", text: pending });
      pending = null;
    }
  }
  if (pending !== null) units.push({ kind: "statement", text: pending });
  return units;
}

const DECISION_OR_VALUE = /[&|?=<>[\]]|"|'|`|new\s|\+\+|--/u;
const IDENTIFIER = /^[A-Za-z_][\w.]*$/u;

/** `return <identifier>;`, or `if (<condition>) return <identifier>;` - a head handing its one job to somewhere else. */
function isDelegation(text) {
  const flat = text.replace(/\s+/gu, " ").trim();
  const guarded = flat.match(/^if \((.*)\) return (.*);$/u);
  const plain = flat.match(/^return (.*);$/u);
  const expression = guarded === null ? plain?.[1] : guarded[2];
  return expression !== undefined && IDENTIFIER.test(expression);
}

/** `Type name = a.b.c;` - reading a value through, with no call, no operator and nothing minted. */
function isPassThroughRead(text) {
  const match = text
    .replace(/\s+/gu, " ")
    .trim()
    .match(/^[A-Za-z_][\w.<>?]* [A-Za-z_]\w* = ([^;]*);$/u);
  return match !== null && !DECISION_OR_VALUE.test(match[1]) && !match[1].includes("(");
}

/**
 * The rule that separates the two facts: a clone window that declares an ENVELOPE is not a copy of an implementation.
 * It must declare something (a window that opens inside a body never qualifies), and every statement in it must be a
 * delegation or a pass-through read - no lookup, no minted receipt, no branch, no literal, no arithmetic. Anything
 * this function does not positively recognise leaves the group a duplication finding, which is the safe direction.
 */
export function isFacadeOnly(fragment) {
  const units = fragmentUnits(fragment);
  if (!units.some((unit) => unit.kind === "declaration")) return false;
  return units
    .filter((unit) => unit.kind === "statement")
    .every((unit) => isDelegation(unit.text) || isPassThroughRead(unit.text));
}

const LITERAL_TEXT = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;

/**
 * The matched text with its string, template and comment literals blanked, so a brace or a semicolon inside a message is
 * not read as a block. This is not a tokeniser: it removes the two constructs whose contents must not be parsed, and the
 * rule below reads punctuation only.
 */
export function withoutLiterals(fragment) {
  return fragment.replace(LITERAL_TEXT, "");
}

/** The text a `;` has to follow to be a statement's end rather than a member of a type or a literal. */
const STATEMENT_TEXT =
  /^(?:return|throw|if|for|foreach|while|switch|const|let|var|await|yield|break|continue|new|delete|using|lock|fixed|checked|unchecked|goto|do|else|case)\b|[=(.[]/u;

/**
 * What stands before a `{` that opens a LITERAL - an object, a type, an argument - rather than a block. A literal is not a
 * statement boundary, so `return { a: 1 };` stays one statement ending where its `;` is, and the brace around it is not
 * credited with a body it does not have.
 */
const LITERAL_INTRODUCER = /[=([,:]|\b(?:return|yield|new|case|else)\s*$/u;

/**
 * Does the matched text contain a BLOCK OF STATEMENTS - a body - or only the floor the language forces on every file of
 * its kind? THIS IS THE UNIT (see the file's header). A `;` inside braces marks them a statement block when what it ends
 * does work; `messageId: string;`, `int slot,` and `evidence,` name members and end nothing. A brace still open where
 * the window ends counts too: jscpd ends a window at the match's last token, and a window that opens a body and is cut
 * off has matched that body's statements.
 */
export function hasStatementBlock(fragment) {
  const text = withoutLiterals(fragment);
  const braces = [];
  // Where the current statement began: after the last `;` or the last openening brace. A closing brace does NOT move it,
  // because `return { a: 1 };` is one statement whose `;` lands after the literal it returned.
  let since = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      braces.push({ statement: false });
      if (!LITERAL_INTRODUCER.test(text.slice(0, index))) since = index + 1;
      continue;
    }
    if (character === "}") {
      if (braces.pop()?.statement === true) return true;
      continue;
    }
    if (character !== ";") continue;
    const top = braces.at(-1);
    const piece = text.slice(since, index).trim();
    if (top !== undefined && piece !== "" && STATEMENT_TEXT.test(piece)) top.statement = true;
    since = index + 1;
  }
  return braces.some((brace) => brace.statement === true);
}

/** The three populations a match belongs to: `facade` and `floor` decide nothing, `duplication` is what the ratchet holds. */
export const FACADE = "facade";
export const SYNTAX_FLOOR = "floor";
export const STRUCTURAL = "duplication";

/** One decision per matched text, in precedence order: a declaration envelope, then a body, then the floor. */
export function groupKind(fragment) {
  if (isFacadeOnly(fragment)) return FACADE;
  return hasStatementBlock(fragment) ? STRUCTURAL : SYNTAX_FLOOR;
}

/** A group whose text is a module preamble, a member list, a one-liner or punctuation: counted, never a finding. */
export function isSyntaxFloor(fragment) {
  return groupKind(fragment) === SYNTAX_FLOOR;
}

/** The group's first line of code, which is what makes a hash recognisable to a reader. */
export function firstLineOf(fragment) {
  const line = fragment.split("\n").find((entry) => entry.trim() !== "") ?? "";
  return line.trim().length > 160 ? `${line.trim().slice(0, 157)}...` : line.trim();
}

/**
 * jscpd's pairwise report, folded into groups: one entry per repeated text, holding every site it was reported at.
 * A pair's two files are both sites, and a site reported by several pairs is counted once. Each group carries the
 * population it belongs to (`facade`, `floor` or `duplication`), decided once from the text that is its identity.
 */
export function groupClones(duplicates, root = REPO) {
  const groups = new Map();
  for (const duplicate of duplicates) {
    const hash = groupHash(duplicate.fragment);
    let group = groups.get(hash);
    if (group === undefined) {
      group = {
        hash,
        tokens: duplicate.tokens,
        fragment: duplicate.fragment,
        kind: groupKind(duplicate.fragment),
        sites: new Map(),
      };
      groups.set(hash, group);
    }
    group.tokens = Math.max(group.tokens, duplicate.tokens);
    for (const site of [duplicate.firstFile, duplicate.secondFile]) {
      const file = normaliseSitePath(site.name, root);
      group.sites.set(`${file}:${site.start}`, { file, line: site.start });
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, sites: [...group.sites.values()].sort(compareSites) }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

const describeSites = (sites) => sites.map((site) => `${site.file}:${site.line}`).join(", ");

/** A rule violation, in the line shape an operator reads first: what it is, where every copy is, what the text is. */
function violation(code, prefix, group) {
  return {
    code,
    hash: group.hash,
    detail: `${prefix}: ${describeSites(group.sites)} :: ${firstLineOf(group.fragment)}`,
  };
}

/**
 * The debt, in the two units a reader needs and one share: the groups the baseline records and the tree still has, the
 * sites those groups occupy, and how much of each is the native-local smoke-runner family.
 *
 * `groups` is the same population `evaluateGroups` reports as `baselined` - this function is where that number is
 * COUNTED, and `evaluateGroups` reads it back as `.groups`, so the two cannot drift into two spellings of one fact.
 */
function debtCensus(groups) {
  const sites = groups.flatMap((group) => group.sites);
  return {
    groups: groups.length,
    sites: sites.length,
    runnerGroups: groups.filter((group) => group.sites.some((site) => isRunnerSite(site.file))).length,
    runnerSites: sites.filter((site) => isRunnerSite(site.file)).length,
  };
}

/**
 * The rule, as one reading of one report: which groups are structural and break it, which of those the baseline
 * already recorded, whether the baseline still describes the tree, and which groups the split read as the floor or as a
 * facade instead. `groups` is `groupClones(...)`; `baseline.groups` is the file.
 *
 * `duplication` is the STRUCTURAL population - the only one a finding can come from - and `syntaxFloor` is the half the
 * split counts and prints and never fails (THE UNIT, above). Growth and staleness are decided by the SITE COUNT. The
 * token count is published as `tokenCountUnstable` instead: at a hash the baseline already records, the fragment is the
 * same bytes by construction, so a different `tokens` there says how far the run matched within that slice, not that more
 * text was copied (THE TOKEN COUNT IS PUBLISHED, above).
 */
export function evaluateGroups({ groups, baseline, declarations = [], minTokens = MIN_TOKENS, minSites = MIN_SITES }) {
  const counted = groups.filter((group) => group.tokens >= minTokens && group.sites.length >= minSites);
  const facade = counted.filter((group) => group.kind === FACADE);
  const syntaxFloor = counted.filter((group) => group.kind === SYNTAX_FLOOR);
  const duplication = counted.filter((group) => group.kind === STRUCTURAL);
  const recorded = new Map((baseline?.groups ?? []).map((entry) => [entry.hash, entry]));
  const declared = new Map(declarations.map((entry) => [entry.hash, entry]));
  const findings = [];
  const tokenCountUnstable = [];
  const debtGroups = [];
  const declaredGroups = [];
  for (const group of duplication) {
    const declaration = declared.get(group.hash);
    if (declaration !== undefined) {
      declaredGroups.push(group);
      if (group.sites.length > declaration.sites)
        findings.push(
          violation(
            "clone_group_grew",
            `clone_group_grew:${group.hash}: now ${group.sites.length} sites at ${group.tokens} tokens, ${DECLARATIONS} ` +
              `declared ${declaration.sites} sites (${declaration.owner})`,
            group,
          ),
        );
      else if (group.sites.length < declaration.sites)
        findings.push({
          code: "stale_clone_declaration",
          hash: group.hash,
          detail:
            `stale_clone_declaration:${group.hash}: ${DECLARATIONS} declares ${declaration.sites} sites and the tree has ` +
            `${group.sites.length} (${describeSites(group.sites)}) - delete the entry, because a declaration may not outlive ` +
            "the copies it names",
        });
      continue;
    }
    const entry = recorded.get(group.hash);
    if (entry === undefined) {
      findings.push(violation("clone_group", `clone_group:${group.tokens}tokens:${group.sites.length}sites`, group));
      continue;
    }
    debtGroups.push(group);
    if (group.sites.length > entry.sites.length) {
      findings.push(
        violation(
          "clone_group_grew",
          `clone_group_grew:${group.hash}: now ${group.sites.length} sites at ${group.tokens} tokens, the baseline ` +
            `recorded ${entry.sites.length} sites at ${entry.tokens} tokens`,
          group,
        ),
      );
      continue;
    }
    if (group.sites.length < entry.sites.length) {
      findings.push(
        violation(
          "stale_clone_baseline",
          `stale_clone_baseline:${group.hash}: the baseline recorded ${entry.sites.length} sites at ${entry.tokens} ` +
            `tokens, the tree now has ${group.sites.length} at ${group.tokens} tokens - record the shrink with ` +
            "--record-shrinks",
          group,
        ),
      );
      continue;
    }
    if (group.tokens !== entry.tokens)
      tokenCountUnstable.push({
        hash: group.hash,
        recorded: entry.tokens,
        measured: group.tokens,
        sites: group.sites.length,
      });
  }
  const live = new Set(duplication.map((group) => group.hash));
  const facades = new Set(facade.map((group) => group.hash));
  const floors = new Set(syntaxFloor.map((group) => group.hash));
  for (const declaration of declared.values()) {
    if (live.has(declaration.hash)) continue;
    findings.push({
      code: "stale_clone_declaration",
      hash: declaration.hash,
      detail:
        `stale_clone_declaration:${declaration.hash}: ${DECLARATIONS} declares ${declaration.sites} sites for a group ` +
        `(${declaration.owner}) the tree no longer has as duplication - delete the entry, because a declaration may not ` +
        "outlive the copies it names",
    });
  }
  for (const entry of recorded.values()) {
    if (live.has(entry.hash)) continue;
    if (facades.has(entry.hash)) {
      findings.push({
        code: "facade_only_clone_baselined",
        hash: entry.hash,
        detail:
          `facade_only_clone_baselined:${entry.hash}: the baseline records ${entry.sites.length} sites at ` +
          `${entry.tokens} tokens (${entry.sites.join(", ")}), and this gate reads that group as a facade - a ` +
          "declaration, not an implementation - so the entry claims duplication the tree does not have: delete it",
      });
      continue;
    }
    if (floors.has(entry.hash)) {
      findings.push({
        code: "syntax_floor_clone_baselined",
        hash: entry.hash,
        detail:
          `syntax_floor_clone_baselined:${entry.hash}: the baseline records ${entry.sites.length} sites at ` +
          `${entry.tokens} tokens (${entry.sites.join(", ")}), and the split reads that group as the syntax floor - a ` +
          "module preamble, a member list or a one-liner, not a body - so the entry banks the floor of the language as " +
          "debt: delete it with --record-shrinks",
      });
      continue;
    }
    findings.push({
      code: "stale_clone_baseline",
      hash: entry.hash,
      detail:
        `stale_clone_baseline:${entry.hash}: the baseline records ${entry.sites.length} sites at ${entry.tokens} tokens ` +
        `(${entry.sites.join(", ")}), and no group that size is in the tree any more - delete the entry`,
    });
  }
  return {
    examinedGroups: groups.length,
    counted,
    facade,
    syntaxFloor,
    duplication,
    debt: debtCensus(debtGroups),
    declared: declaredGroups,
    declarations,
    undeclared: duplication.filter((group) => !declared.has(group.hash)),
    baselined: debtGroups.length,
    newGroups: findings.filter((entry) => entry.code === "clone_group").length,
    grown: findings.filter((entry) => entry.code === "clone_group_grew").length,
    stale: findings.filter((entry) => entry.code === "stale_clone_baseline").length,
    reclassified: findings.filter((entry) => entry.code === "facade_only_clone_baselined").length,
    floorBaselined: findings.filter((entry) => entry.code === "syntax_floor_clone_baselined").length,
    staleDeclarations: findings.filter((entry) => entry.code === "stale_clone_declaration").length,
    tokenCountUnstable,
    findings,
  };
}

/** `jscpd.json` and this file must say the same thing, or the report and the gate examine different trees. */
export function configDisagreements({ config, sourceTrees = SOURCE_TREES, formats = FORMATS, ignores = IGNORES }) {
  const disagreements = [];
  const same = (field, ours, theirs) => {
    const left = [...ours].sort().join("\n");
    const right = [...(Array.isArray(theirs) ? theirs : [])].sort().join("\n");
    if (left !== right) disagreements.push({ field, ours: [...ours].join(","), config: right.replaceAll("\n", ",") });
  };
  same("path", sourceTrees, config.path);
  same("format", formats, config.format);
  same("ignore", ignores, config.ignore);
  for (const field of ["minTokens", "minLines"]) {
    const ours = field === "minTokens" ? MIN_TOKENS : MIN_LINES;
    if (config[field] !== ours) disagreements.push({ field, ours: String(ours), config: String(config[field]) });
  }
  return disagreements;
}

/**
 * Run the installed jscpd over the trees being examined and read the JSON report it wrote. The report is the artifact:
 * the console counts are not parsed, and a run that printed a verdict but wrote no readable report is `blocked`.
 *
 * jscpd resolves from THIS file, not from the examined tree: it is a devDependency of this repository, and a synthetic
 * tree in a throwaway directory must be measurable by the same binary as the repository itself.
 */
export function runJscpd({
  root = REPO,
  trees = SOURCE_TREES,
  formats = FORMATS,
  ignores = IGNORES,
  spawn = spawnSync,
} = {}) {
  let entry;
  try {
    entry = createRequire(import.meta.url).resolve(JSCPD_ENTRY);
  } catch {
    return { ok: false, reason: `jscpd_not_installed: ${JSCPD_ENTRY} does not resolve from ${REPO}` };
  }
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "gamebuddy-clones-"));
  try {
    const args = [
      entry,
      ...trees,
      "--min-tokens",
      String(MIN_TOKENS),
      "--min-lines",
      String(MIN_LINES),
      "--format",
      formats.join(","),
      "--ignore",
      ignores.join(","),
      "--reporters",
      "json",
      "--output",
      output,
      "--absolute",
      "--silent",
    ];
    const outcome = spawn(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 10 * 60_000 });
    if (outcome.error?.code === "ETIMEDOUT") return { ok: false, reason: "jscpd_timeout:10000ms" };
    const reportPath = path.join(output, "jscpd-report.json");
    if (!fs.existsSync(reportPath)) {
      const said = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`
        .trim()
        .split("\n")
        .find((line) => line.trim());
      return {
        ok: false,
        reason: `jscpd_report_missing: exit=${outcome.status} ${said ?? "(it printed nothing)"}`.trim(),
      };
    }
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    if (outcome.status !== 0)
      return { ok: false, reason: `jscpd_failed: exit=${outcome.status} despite writing a report` };
    return { ok: true, report };
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

/** The files each declared format was actually tokenised in, so a dropped tree is a blocked reading. */
export function formatPopulations(report, formats = FORMATS) {
  return Object.fromEntries(formats.map((format) => [format, report.statistics?.formats?.[format]?.sources ?? 0]));
}

/** The baseline payload for a set of groups: what the ratchet records and nothing it could re-derive. */
export function baselinePayload(groups) {
  return {
    groups: [...groups]
      .sort((left, right) => left.hash.localeCompare(right.hash))
      .map((group) => ({
        hash: group.hash,
        tokens: group.tokens,
        sites: group.sites.map((site) => `${site.file}:${site.line}`),
      })),
  };
}

/** One group per line, so a shrink is a diff of lines rather than a re-indented block. */
export function serialiseBaseline(payload) {
  const groups = payload.groups.map(
    (group) => `    ${JSON.stringify({ hash: group.hash, tokens: group.tokens, sites: group.sites })}`,
  );
  return `{\n  "groups": [\n${groups.join(",\n")}\n  ]\n}\n`;
}

/** The baseline file, or `null` when there is none: "no baseline" and "an empty baseline" are different facts. */
export function readBaseline({ root = REPO } = {}) {
  const file = path.join(root, BASELINE);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.groups)) throw new Error("duplicate_code_baseline_malformed:groups");
  return parsed;
}

/**
 * The declaration file: groups whose fix is owned by a lane this one may not edit. It is READ, never written - nothing in
 * this gate adds a declaration, exactly as nothing in it adds a baseline entry (THE DECLARATION DOOR, in the header). A
 * missing file is "nothing is declared", and a malformed one is an error rather than a reading: an entry with no reason
 * is the thing the door exists to refuse.
 */
export function readDeclarations({ root = REPO } = {}) {
  const file = path.join(root, DECLARATIONS);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.declarations)) throw new Error("duplicate_code_declarations_malformed:declarations");
  const seen = new Set();
  for (const entry of parsed.declarations) {
    if (typeof entry.hash !== "string" || !/^[0-9a-f]{12}$/u.test(entry.hash))
      throw new Error(`duplicate_code_declarations_malformed:hash:${JSON.stringify(entry.hash)}`);
    if (seen.has(entry.hash)) throw new Error(`duplicate_code_declarations_malformed:duplicate_hash:${entry.hash}`);
    seen.add(entry.hash);
    if (!Number.isInteger(entry.sites) || entry.sites < MIN_SITES)
      throw new Error(`duplicate_code_declarations_malformed:sites:${entry.hash}`);
    for (const field of ["owner", "reason"])
      if (typeof entry[field] !== "string" || entry[field].trim() === "")
        throw new Error(`duplicate_code_declarations_malformed:${field}:${entry.hash}`);
  }
  return parsed.declarations;
}

/**
 * The files under `trees` that are in the worktree but not in the index: the complement of the population
 * (THE POPULATION IS THE INDEX, above).
 *
 * `error` rather than an empty set when git cannot answer. An empty set says "nothing is untracked", which is the
 * opposite of what an unreadable index means for a population that is supposed to be the index, and it would let a
 * fixture tree be measured as if every file in it were committed.
 */
export function untrackedSources({ root = REPO, trees = SOURCE_TREES, spawn = spawnSync } = {}) {
  const outcome = spawn("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...trees], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1 << 26,
  });
  if (outcome.status !== 0) return { error: `git_index_unreadable:${root}` };
  return {
    files: new Set(
      String(outcome.stdout ?? "")
        .split("\0")
        .filter((name) => name !== "")
        .map((name) => name.replace(/\\/gu, "/")),
    ),
  };
}

/**
 * The last commit that touched a file: `{ commit, date, subject }`, or `{ unrecorded: <reason> }` when no commit holds
 * it. This is the attribution unit, and it is a FILE-LEVEL reading that says so in its own words (ATTRIBUTION, above):
 * `git blame` costs 0.2-0.7s a call on this tree, which a gate that runs on every commit cannot pay per site.
 */
export function lastTouchedBy(file, { root = REPO, spawn = spawnSync, cache = new Map() } = {}) {
  if (cache.has(file)) return cache.get(file);
  const outcome = spawn("git", ["log", "-1", "--format=%h%x09%as%x09%s", "--", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const [commit, date, subject] = String(outcome.stdout ?? "")
    .trim()
    .split("\t");
  const reading =
    outcome.status === 0 && commit
      ? { commit, date, subject: subject ?? "" }
      : { unrecorded: `no commit holds ${file}` };
  cache.set(file, reading);
  return reading;
}

/**
 * The commit behind each group's most recent site, one reading per group: the site whose file was touched last, named
 * with the commit that touched it. A group with no reading at all carries the reason instead of a hash.
 */
export function attributeGroups(groups, { root = REPO, spawn = spawnSync } = {}) {
  const cache = new Map();
  return groups.map((group) => {
    const touched = group.sites.map((site) => ({ site, reading: lastTouchedBy(site.file, { root, spawn, cache }) }));
    const recorded = touched
      .filter((entry) => entry.reading.commit !== undefined)
      .sort((left, right) => right.reading.date.localeCompare(left.reading.date));
    if (recorded.length === 0) return { hash: group.hash, unrecorded: touched[0]?.reading.unrecorded };
    const { site, reading } = recorded[0];
    return { hash: group.hash, site, commit: reading.commit, date: reading.date, subject: reading.subject };
  });
}

/** The whole reading, for the CLI and for the test: population, rule, findings, verdict. */
export function checkCodeDuplication({
  root = REPO,
  trees = SOURCE_TREES,
  formats = FORMATS,
  ignores = IGNORES,
  baseline = readBaseline({ root }),
  declarations = readDeclarations({ root }),
  spawn = spawnSync,
  config,
} = {}) {
  const disagreements = configDisagreements({
    config: config ?? JSON.parse(fs.readFileSync(path.join(root, JSCPD_CONFIG), "utf8")),
    sourceTrees: trees,
    formats,
    ignores,
  });
  const run = runJscpd({ root, trees, formats, ignores, spawn });
  if (!run.ok) return { status: "blocked", reason: run.reason, disagreements, examined: 0 };
  const untracked = untrackedSources({ root, trees });
  if (untracked.error !== undefined) return { status: "blocked", reason: untracked.error, disagreements, examined: 0 };
  const examined = run.report.statistics?.total?.sources ?? 0;
  const populations = formatPopulations(run.report, formats);
  // The pairs git has no index entry for are dropped together with whatever they would have joined, and the files that
  // were dropped are counted so a reading that shrank its population says so.
  const pairs = [];
  const outsideIndex = new Set();
  for (const duplicate of run.report.duplicates ?? []) {
    const first = normaliseSitePath(duplicate.firstFile.name, root);
    const second = normaliseSitePath(duplicate.secondFile.name, root);
    if (!(untracked.files.has(first) || untracked.files.has(second))) {
      pairs.push(duplicate);
      continue;
    }
    if (untracked.files.has(first)) outsideIndex.add(first);
    if (untracked.files.has(second)) outsideIndex.add(second);
  }
  const groups = groupClones(pairs, root);
  const empty = Object.entries(populations)
    .filter(([, files]) => files === 0)
    .map(([format]) => format);
  if (examined === 0)
    return {
      status: "blocked",
      reason: "code_duplication_examined_no_files",
      populations,
      disagreements,
      examined,
    };
  if (empty.length > 0)
    return {
      status: "blocked",
      reason: `format_examined_no_files:${empty.join(",")}`,
      populations,
      disagreements,
      examined,
    };
  const reading = evaluateGroups({ groups, baseline, declarations });
  const ruleFindings = [
    ...disagreements.map((entry) => ({
      code: "jscpd_config_disagrees",
      detail: `jscpd_config_disagrees:${entry.field}: the config declares ${entry.config || "(nothing)"}, this gate ${entry.ours}`,
    })),
    ...reading.findings,
  ];
  const findings = attachAttribution(ruleFindings, { groups: reading.counted, root, spawn });
  return {
    status: findings.length === 0 ? "passed" : "failed",
    examined,
    populations,
    ...reading,
    untrackedNotCounted: outsideIndex.size,
    findings,
  };
}

/**
 * The commit behind each finding, on the finding rather than inside `detail` - `detail` is the rule's reading of the text
 * and a test asserts it byte for byte, while the attribution is a fact about the file that can move without the rule
 * moving. A finding for a group the tree no longer has (a stale entry) carries the group's sites nowhere, so it carries
 * no attribution: there is no site to attribute.
 */
export function attachAttribution(findings, { groups, root = REPO, spawn = spawnSync } = {}) {
  const byHash = new Map(groups.map((group) => [group.hash, group]));
  const targets = findings.filter((finding) => byHash.has(finding.hash));
  const attributed = new Map(
    attributeGroups(
      targets.map((finding) => byHash.get(finding.hash)),
      { root, spawn },
    ).map((entry) => [entry.hash, entry]),
  );
  return findings.map((finding) =>
    attributed.has(finding.hash) ? { ...finding, attribution: attributed.get(finding.hash) } : finding,
  );
}

/** The report line `tools/check-harness-conformance.mjs` reads: the gate's own id, verdict and population. */
function reportLine(reading) {
  const checks = [
    {
      id: "clone_groups_within_baseline",
      status: reading.status === "failed" ? "failed" : reading.status === "blocked" ? "blocked" : "passed",
    },
  ];
  return JSON.stringify({
    gate: "code_duplication",
    status: reading.status,
    examined: reading.examined,
    ...(reading.untrackedNotCounted === undefined ? {} : { untrackedNotCounted: reading.untrackedNotCounted }),
    ...(reading.reason === undefined ? {} : { reason: reading.reason }),
    ...(reading.counted === undefined
      ? {}
      : {
          cloneGroups: reading.counted.length,
          facadeOnly: reading.facade.length,
          syntaxFloor: reading.syntaxFloor.length,
          duplication: reading.duplication.length,
          declared: reading.declared.length,
        }),
    checks,
  });
}

/** A facade group, named so the reader can see what the rule let through and disagree with it. */
export function facadeLine(group) {
  return (
    `  facade-only:${group.hash}: ${group.sites.length} sites at ${group.tokens} tokens :: ${describeSites(group.sites)} ` +
    `:: ${firstLineOf(group.fragment)}`
  );
}

/** One recorded token count the tree does not reproduce, named with both numbers and the site count that did not move. */
export function tokenCountLine(entry) {
  return (
    `  token_count_unstable:${entry.hash}: ${entry.recorded} -> ${entry.measured} tokens at ${entry.sites} sites - the ` +
    "fragment is unchanged, so this is the matched run over the same text, not a new copy"
  );
}

/** One declared group, printed every run: the door is only honest while a reader can see who walked through it. */
export function declaredLine(group, declaration) {
  return (
    `  declared:${group.hash}: ${group.sites.length} sites at ${group.tokens} tokens · ${declaration.owner} · ` +
    `${declaration.reason} :: ${firstLineOf(group.fragment)}`
  );
}

/**
 * The debt as ONE line a reader can act on: how many recorded groups, how many sites, and how much of it is the runner
 * family. A blocked reading says `not measured` and its reason, because `0 groups` beside a reading that examined nothing
 * is the ambiguity this line exists to remove.
 */
export function debtLine(reading) {
  if (reading.debt === undefined)
    return `debt: not measured · ${reading.reason ?? "the reading carries no population"}`;
  const { groups, sites, runnerGroups, runnerSites } = reading.debt;
  return `debt: ${groups} groups · ${sites} sites · of which runners ${runnerGroups} groups / ${runnerSites} sites`;
}

/**
 * The report of a reading a WRITE has just produced: `evaluateGroups` returns a population without a verdict, and a
 * report that omits `status` is the ambiguity this file exists to remove - so the verdict is derived from the findings
 * the recorded payload produces, not from the run that preceded the write.
 */
function writtenReport(reading) {
  return reportLine({ ...reading, status: (reading.findings ?? []).length === 0 ? "passed" : "failed" });
}

export function censusLine(reading) {
  if (reading.status === "blocked")
    return `files examined ${reading.examined} · clone groups 0 · BLOCKED ${reading.reason}`;
  const sitesOf = (groups) => groups.reduce((total, group) => total + group.sites.length, 0);
  return (
    `files examined ${reading.examined} · clone groups ${reading.counted.length} · of which facade-only ` +
    `${reading.facade.length} · syntax-floor ${reading.syntaxFloor.length} (${sitesOf(reading.syntaxFloor)} sites) · ` +
    `duplication ${reading.duplication.length} (${sitesOf(reading.duplication)} sites) · ` +
    `${(reading.declared ?? []).length === 0 ? "" : `declared ${reading.declared.length} · `}` +
    `new ${reading.newGroups} · ` +
    `grown ${reading.grown} · baselined ${reading.baselined}` +
    `${reading.stale === 0 ? "" : ` · stale ${reading.stale}`}` +
    `${reading.reclassified === 0 ? "" : ` · reclassified ${reading.reclassified}`}` +
    `${(reading.staleDeclarations ?? 0) === 0 ? "" : ` · stale_declarations ${reading.staleDeclarations}`}` +
    `${(reading.floorBaselined ?? 0) === 0 ? "" : ` · syntax_floor_baselined ${reading.floorBaselined}`}` +
    `${reading.tokenCountUnstable === undefined || reading.tokenCountUnstable.length === 0 ? "" : ` · token_count_unstable ${reading.tokenCountUnstable.length}`}` +
    `${reading.untrackedNotCounted === undefined || reading.untrackedNotCounted === 0 ? "" : ` · untracked_not_counted ${reading.untrackedNotCounted}`}`
  );
}

/** One structural group, baselined or not, with the commit behind it: the residual list `--residuals` prints. */
export function residualLine(group, attribution) {
  return (
    `  residual:${group.hash}: ${group.sites.length} sites at ${group.tokens} tokens · last touched ` +
    `${attributionLine(attribution)} :: ${firstLineOf(group.fragment)}`
  );
}

/**
 * What `--write-baseline` must refuse to record: a group that is new or grew. The first write is the only one that may
 * name groups this file has never recorded - that is how today's tree is written down - and every later write may only
 * record a shrink, so a green run never becomes the way to accept new duplication.
 */
export function baselineWriteRefusal({ reading, creating }) {
  if (creating) return [];
  return (reading.findings ?? []).filter((entry) => entry.code === "clone_group" || entry.code === "clone_group_grew");
}

/**
 * The other write, and the only one whose power is downward: every recorded entry either loses its place because the
 * group left the duplication population, is lowered onto the sites the tree still has, or is left exactly as it is. It
 * cannot add a group or raise one, so the groups that are new or grew stay findings and are never banked here.
 *
 * `payload` is what the file becomes; `after` is the reading that file would produce, so the caller prints the truth it
 * has just recorded rather than a hopeful verdict.
 */
export function recordShrinks({ reading, baseline }) {
  if (reading.counted === undefined)
    return { refused: "baseline_shrink_refused: the reading is blocked, so there is no population to compare" };
  if (baseline === null)
    return {
      refused:
        `baseline_shrink_refused: there is no ${BASELINE} to shrink - this operation may only remove or lower an existing ` +
        "record; --write-baseline creates one",
    };
  const live = new Map(reading.duplication.map((group) => [group.hash, group]));
  const groups = [];
  const removed = [];
  const lowered = [];
  for (const entry of baseline.groups) {
    const group = live.get(entry.hash);
    if (group === undefined) {
      removed.push(entry.hash);
      continue;
    }
    if (group.sites.length < entry.sites.length) {
      lowered.push(entry.hash);
      groups.push({ ...entry, sites: group.sites.map((site) => `${site.file}:${site.line}`) });
      continue;
    }
    groups.push(entry);
  }
  const payload = { groups };
  return {
    payload,
    removed,
    lowered,
    after: evaluateGroups({ groups: reading.counted, baseline: payload, declarations: reading.declarations ?? [] }),
  };
}

/** One recorded group's attribution, as the line a reader checks: the commit, its date and its subject. */
export function attributionLine(attribution) {
  if (attribution?.commit === undefined)
    return `unrecorded (${attribution?.unrecorded ?? "no commit holds this group"})`;
  return `${attribution.commit} ${attribution.date} ${attribution.subject} (${attribution.site.file}:${attribution.site.line})`;
}

function main(argv) {
  const writeBaseline = argv.includes("--write-baseline");
  const recordingShrinks = argv.includes("--record-shrinks");
  const showingResiduals = argv.includes("--residuals");
  // `--root <dir>`: which tree's baseline (and `jscpd.json`) is read and written. Fixtures use it; the rule is the same.
  const root = argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : REPO;
  let reading;
  let baseline;
  try {
    baseline = readBaseline({ root });
    reading = checkCodeDuplication({ root, baseline });
  } catch (error) {
    process.stdout.write(`code_duplication_blocked: ${String(error?.message ?? error)}\n`);
    process.stdout.write(`${reportLine({ status: "blocked", examined: 0 })}\n`);
    process.exitCode = 2;
    return;
  }
  const lines = [censusLine(reading), debtLine(reading)];
  for (const group of reading.facade ?? []) lines.push(facadeLine(group));
  const declarations = new Map((readDeclarations({ root }) ?? []).map((entry) => [entry.hash, entry]));
  for (const group of reading.declared ?? []) lines.push(declaredLine(group, declarations.get(group.hash)));
  for (const entry of reading.tokenCountUnstable ?? []) lines.push(tokenCountLine(entry));
  for (const entry of reading.findings ?? [])
    lines.push(
      `  ${entry.detail}` +
        `${entry.attribution === undefined ? "" : ` · last touched ${attributionLine(entry.attribution)}`}`,
    );
  // THE RESIDUALS: every structural group the ratchet carries, with the commit behind its most recent site, so "predates
  // this lane" is a hash a reader checks. It costs one `git log` per distinct file, which is why it is asked for rather
  // than printed on every run - the default run attributes its findings only, and a green run attributes nothing.
  if (showingResiduals) {
    const groups = reading.duplication ?? [];
    const attributed = attributeGroups(groups, { root });
    const byHash = new Map(attributed.map((entry) => [entry.hash, entry]));
    const commits = new Set(attributed.map((entry) => entry.commit ?? entry.unrecorded));
    lines.push(
      `residuals: ${groups.length} groups · ${groups.reduce((total, group) => total + group.sites.length, 0)} sites · ` +
        `${commits.size} commit(s)`,
    );
    for (const group of [...groups].sort(
      (left, right) =>
        (byHash.get(right.hash)?.date ?? "").localeCompare(byHash.get(left.hash)?.date ?? "") ||
        left.hash.localeCompare(right.hash),
    ))
      lines.push(residualLine(group, byHash.get(group.hash)));
  }
  if (recordingShrinks) {
    const outcome = recordShrinks({ reading, baseline });
    if (outcome.refused !== undefined) {
      lines.push(outcome.refused);
      process.stdout.write(`${lines.join("\n")}\n`);
      process.stdout.write(`${reportLine(reading)}\n`);
      process.exitCode = reading.counted === undefined ? 2 : 1;
      return;
    }
    if (outcome.removed.length + outcome.lowered.length > 0)
      fs.writeFileSync(path.join(root, BASELINE), serialiseBaseline(outcome.payload), "utf8");
    lines.push(
      `shrinks recorded: ${outcome.removed.length + outcome.lowered.length} · removed ${outcome.removed.length} · ` +
        "nothing added",
    );
    if (outcome.after.newGroups + outcome.after.grown > 0)
      lines.push(
        `not recorded: new ${outcome.after.newGroups} · grown ${outcome.after.grown} - this operation may only ` +
          "remove or lower an entry, so these stay findings for --write-baseline",
      );
    process.stdout.write(`${lines.join("\n")}\n`);
    process.stdout.write(`${writtenReport(outcome.after)}\n`);
    return;
  }
  if (writeBaseline) {
    if (reading.counted === undefined) {
      lines.push("baseline_write_refused: the reading is blocked, so there is no population to record");
      process.stdout.write(`${lines.join("\n")}\n`);
      process.stdout.write(`${reportLine(reading)}\n`);
      process.exitCode = 2;
      return;
    }
    const creating = baseline === null;
    const refused = baselineWriteRefusal({ reading, creating });
    if (refused.length > 0) {
      lines.push(
        `baseline_write_refused: ${refused.length} group(s) are new or grew - the baseline may only record a shrink`,
      );
      process.stdout.write(`${lines.join("\n")}\n`);
      process.stdout.write(`${reportLine({ ...reading, status: "failed" })}\n`);
      process.exitCode = 1;
      return;
    }
    const payload = baselinePayload(reading.undeclared ?? reading.duplication);
    fs.writeFileSync(path.join(root, BASELINE), serialiseBaseline(payload), "utf8");
    lines.push(
      `${creating ? "baseline_created" : "baseline_written"}: ${payload.groups.length} group(s) -> ${BASELINE}` +
        `${(reading.declared ?? []).length === 0 ? "" : ` · ${reading.declared.length} declared group(s) are not recorded here`}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    process.stdout.write(`${reportLine({ ...reading, status: "passed" })}\n`);
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(`${reportLine(reading)}\n`);
  if (reading.status !== "passed") process.exitCode = reading.status === "blocked" ? 2 : 1;
}

if (import.meta.main) main(process.argv.slice(2));
