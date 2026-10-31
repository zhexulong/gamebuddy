# AGENTS.md

- Do not optimize for backward compatibility. Remove legacy code paths rather than maintaining compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that meets current requirements. Avoid unnecessary abstractions, configuration, and indirection.
- Build systems incrementally in layers. First, create a minimal end-to-end version that works, then add features on top of a stable product. Do not replace working products with premature complexity.
- Keep components modular with clear separation of responsibilities and concerns.
- Prefer mature, well-maintained libraries when they reduce complexity or improve reliability. Do not rewrite common functionality without a compelling reason.
- Before implementing something yourself or adding a dependency, check what existing dependencies can do. Read their documentation and type definitions first; do not assume a library cannot do it.
- Make architecture decisions for the long term. Do not accept temporary solutions that solve the immediate problem but will inevitably need replacing.
- Before designing a solution, research how established products solve similar problems. Prefer proven patterns and conventions over inventing one from scratch.
- Avoid defensive over-engineering and ritualistic validation (such as arbitrary cryptographic hashes, intra-process attestation chains, or redundant verification gates). Before introducing any hash, signature, or gate, clearly define the concrete incident or failure it prevents and why standard mechanisms are insufficient; if it cannot be clearly justified against realistic threat models, do not add it.
- **Laziness Protocol (Minimal Change & Negative Delta)**: Bias toward deletion and the smallest change that solves the problem. When solving runtime issues, fix the invariant at the lowest native layer (e.g., database timeout or engine tick loop) rather than adding defensive wrapper layers or retry middleware.
- **Workspace & Code Hygiene**: Never drop ad-hoc diagnostic scripts (`diag-*.mjs`, `read-*.mjs`) into the repository root; all temporary exploratory scripts belong in `scratch/` or `.tmp/`. Before completion, run `/no-comments` to eliminate AI narration comments, dead commented-out code, and compiler suppression directives (`@ts-ignore`, `eslint-disable`).
- **Workflow Playbooks & Authority**:
  - *Domain / Gameplay Operations*: Changes touching gameplay state, SMAPI native seams, or companion protocol actions must strictly follow the `game-action-boundary` → `game-action-implement` → `game-action-close` pipeline.
  - *General Engineering*: Use TDD (reproducible red check → minimal native fix → green verify) for bug fixes, and strict zero-behavior-change passes for refactoring.
  - *Multi-agent Delegation*: Use `subagent-driven-development` as the primary engine for sliced parallel execution and progressive gate review.
- **Attribution Discipline (evidence against your hypothesis, not for it)**: When a run does not behave as expected, do not start from a hypothesis and then grep for the facts that support it. Collect the facts first - including the ones that would refute you - and only then form the explanation. A missing tool call is not evidence that the capability is absent: it may mean the caller tried and was refused, so always count the *refusals* beside the *calls* (2026-10-22: seven `body_program_preflight_rejected` and four mentions of the program id sat in the session file while I concluded "the model refuses to batch"; the truth was it tried three programs, was refused with a code that named nothing, and reasonably fell back to two hundred single steps). When an agent's own account is available, ask it before theorising - `design/handbook/live-attribution.md` is the fixed procedure - and then verify that account against the artifacts rather than trusting either alone.
- **Change Discipline** (executable version: `design/operations/change-discipline.md`):
  - *One unit, one commit, the moment it is green*; explicit pathspec every time, and read the hook's printed staged set. Never `restore`/`checkout --`/`stash`/`clean` another lane's uncommitted work; foreign hunks go to their owner or through the private index.
  - *Confirm the revision before comparing anything*; a clean worktree is not evidence.
  - *Ask how CI runs it before you call it red*: an unofficial invocation answers a question nobody asked, and it does
    not announce itself as such. `node --test x.mjs` where the file imports `.ts`, `biome check .` where the script says
    `biome check src`, or a linter run on the CRLF worktree instead of the `git archive` - each one produced a confident
    "failure" that the authoritative command reports as green. Read the `package.json` script or the workflow step first.
  - *A lane's task must fit in one transmission*: an agent that is cut off mid-recon leaves nothing, and the work is lost
    with the context. Land the red gate first, then one unit per commit - five lanes died with an empty disk under a single
    large instruction, and the three that were given "commit the red gate, then each unit separately" all finished.
  - *Every new assertion must be seen red once* on a real injected violation.
  - *Diagnose by executing, not by reading*: a probe that calls the real function with real inputs settles in
    seconds what reading the predicate cannot settle at all. A diagnostic that re-implements the logic can disagree
    with it, and then it is worse than none - it sends you to a layer where the defect is not. When a value is
    "present" but not taking effect, find the layer that decides and ask it, outside in: the deciding layer is often
    a shape test above the predicate everyone is reading.
  - *A check's boundary is what it reads*: when a gate is green and the defect is real, ask what it reads before
    what it checks. A gate that tests a substring, a file it never loads, or a variable declared after its own
    insertion point will stay green through the defect it exists for - which is why the red case comes first.
  - *No fact gets two spellings*: derive from the union/descriptor/constant and assert equality.
  - *Fix the owning layer, not the call site* (one mapper, not twenty-four; the producer, not a downstream stripper).
  - *A destructive action carries no effect the player cannot foresee*; if it leaves data unreachable, fix reachability rather than delete to tidy up.
  - *Pair every "unchanged" claim with both readings from the same run*; say what you did not verify.
  - *Start from the existing gauntlets* (`tools/audit-totality.mjs`, the problem-code gate, `tools/live-run/**`, `tools/shots/**`) instead of writing a fifth.
- **Defect Families & Invariant Gates**: When a defect recurs, stop fixing individual instances; encode an automated gate for the entire failure class. Tests must assert durable invariants rather than pinning transient implementations:
  - *Zero forward path*: Every reachable non-terminal state in a lifecycle or state machine must offer at least one valid forward action.
  - *First-viewport reachability*: Primary action controls must remain fully visible within the baseline viewport (including mobile 400x800) without requiring container scroll.
  - *End-to-end data consumption*: Any configuration or card field accepted and stored for runtime use must be asserted to reach the assembled prompt or execution pipeline.
  - *Draft preservation*: User input must never be discarded on API, validation, or network failures; verify text retention across all failure shapes.
  - *Lossless round-trip*: Exporting imported structures must preserve all accepted fields and metadata without silent loss or mutation.
  - *Surface protocol isolation*: Surface-specific instructions and tool bindings must remain strictly isolated to their target runtime, verified by negative assertions on other surfaces.
  - *Ceiling saturation*: any collection, log, journal or counter that a session appends to must be pushed past the size a long session produces, asserting it still validates and the newest entry still answers. A hard bound with no eviction is a save-file suicide note; two runs filled this repository's journal to 49% of its ceiling.
  - *State observability*: every external state change the product cannot prevent (a modal, a death, a festival, a location change under an in-flight execution) must be observable as a named fact. A state nobody can see is a state the agent plans against wrongly - do not add a recovery workflow for it, add the observation.
  - *Cross-process identity*: where a producer in one language publishes a value that a consumer in another validates, the value must cross a real sample of the producer's output, not two hand-written mocks. Two mocks that agree prove nothing about the two systems.
- **Test the shapes a producer can emit, not the shapes a reviewer can imagine**: a case is worth writing when you can name the code path that would produce it. Before adding a case for an exotic input, name the producer; if there is none, say so instead of adding coverage. The converse binds harder: a shape the producer demonstrably emits (an unbounded append, a negative boundary coordinate, a quality roll on a full pack) is real even when it looks unlikely, and skipping it is how a defect reaches a live run.
- **Three tiers, and know which one you are in**: a defect caught by a unit test costs minutes, one caught by a cross-process gate costs a commit, and one caught only by a live run costs a night. When a defect escapes, ask which tier should have caught it and add the case there rather than only fixing the instance. Most "runtime-only" defects are capacity, state-combination or observation gaps - all three are testable without launching the game; only timing/concurrency and model behaviour genuinely need a live run.
- **Gates and tests are built for the future, not for today's tree**: a gate must keep meaning something after the code it was written against changes. Derive its population from the authority (a union, a descriptor, a constant, a directory scan) instead of a hand-maintained list; make the failure message name the drifting member so the next agent knows what to fix; let it fail loudly on drift rather than silently narrowing; and when a premise genuinely changes, update the premise and keep the assertion's force. A check that only passes because the thing it watched disappeared is a check that has stopped working.
- For product architecture, domain behavior, ADRs, active implementation tasks, research, or historical design, read the private `zhexulong/gamebuddy-docs` repository mounted locally at `design/`; start at `design/README.md` and follow its current-owner links. Numbered root files under `design/` are migration sources, not current authority unless a current document explicitly names one.
