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

  On meeting **any** defect, before fixing the instance, ask: **what class does this belong to, and what gate would have caught every member of it?** A fix without that question buys one instance and leaves the class alive. The gate is the deliverable; the fix is the side effect. Write the gate first, red, against the real defect - then fix.
  - *Zero forward path*: Every reachable non-terminal state in a lifecycle or state machine must offer at least one valid forward action.
  - *First-viewport reachability*: Primary action controls must remain fully visible within the baseline viewport (including mobile 400x800) without requiring container scroll.
  - *End-to-end data consumption*: Any configuration or card field accepted and stored for runtime use must be asserted to reach the assembled prompt or execution pipeline.
  - *Draft preservation*: User input must never be discarded on API, validation, or network failures; verify text retention across all failure shapes.
  - *Lossless round-trip*: Exporting imported structures must preserve all accepted fields and metadata without silent loss or mutation.
  - *Surface protocol isolation*: Surface-specific instructions and tool bindings must remain strictly isolated to their target runtime, verified by negative assertions on other surfaces.
  - *Bounded collections have a drain*: anything a run appends to either has an eviction path or is derived from a measured population. State which, and test the case where the drain is slower than the fill.
  - *Observable state*: every condition the code can distinguish but cannot prevent has a named field or event a caller can act on. If no such field exists, the condition is invisible, not handled.
  - *Single authority per fact*: a value that crosses a process or language boundary is checked against the producer's real output, not a second hand-written copy of it. Two copies that agree today are a disagreement scheduled for later.
- **Write tests with Right-BICEP, not with intuition**: *Right* - are the results right? *Boundary* - see CORRECT below. *Inverse* - does the reverse operation recover the input? *Cross-check* - does a second method agree? *Error* - can every error condition be forced? *Performance* - is it within its budget? A suite that only tests the happy path of the function you just wrote is the default outcome, not a considered one.
- **Boundaries are CORRECT**: *Conformance* (format), *Ordering* (sequence or set), *Range* (min/max), *Reference* (external state the code does not control), *Existence* (non-null, non-empty, present), *Cardinality* (exactly enough), *Time* (ordering, absolute, relative). Most defects live here - a tree at health 10 versus 1, a coordinate at -1, a pack with 36 slots versus 35.
- **A good test is A TRIP**: *Automatic* (no manual step), *Thorough* (covers the boundaries and the errors), *Repeatable* (same result every run, no clock or network dependency), *Independent* (no order dependency), *Professional* (named for the property it protects, and its failure message says what broke).
- **Test doubles are for boundaries you do not own**: mock the network, the clock, the filesystem, another process. Do not mock the type you are testing or the collaborator you are integrating with - a suite where every dependency is a double reaches 100% while the product does not run. When two components must agree, drive the test from one side's REAL output (see *single authority* above).
- **Gates and tests are built for the future, not for today's tree**: a gate must keep meaning something after the code it was written against changes. Derive its population from the authority (a union, a descriptor, a constant, a directory scan) instead of a hand-maintained list; make the failure message name the drifting member so the next agent knows what to fix; let it fail loudly on drift rather than silently narrowing; and when a premise genuinely changes, update the premise and keep the assertion's force. A check that only passes because the thing it watched disappeared is a check that has stopped working.
  A **gate** is not a test with a wider name. A test pins a behaviour someone already thought of; a gate makes a whole class of defect fail loudly for members nobody has written yet. The distinction is operational:

  - **Population from the authority.** The set of things checked must come from a declaration the product already owns - a union type, a route table, a descriptor, a directory scan, a generated artifact. If the set is a hand-written list, it is a test: it can only catch what its author remembered, and it fails open the first time someone adds a member.
  - **Assert a property, not a member.** `isWarp is the only optional key` is a test. `every optional key in a validator is either published by its record or carries a stated reason here` is a gate.
  - **Name the drifting member.** A failure has to say which action, family or field broke, and what would have to change. A gate that says "expected true, got false" costs the next reader an afternoon.
  - **Prove it red on real history.** Injecting the defect you had in mind proves you can turn your own gate red. Stronger, and the one to prefer: check out the commit before a defect that actually shipped and confirm the gate fires. If no real defect exists to replay, say so instead of substituting a synthetic one.
  - **It should make you want to change the structure.** A gate that keeps firing on a growing exception list is telling you the shape is wrong. Fix the shape; do not grow the list.
- For product architecture, domain behavior, ADRs, active implementation tasks, research, or historical design, read the private `zhexulong/gamebuddy-docs` repository mounted locally at `design/`; start at `design/README.md` and follow its current-owner links. Numbered root files under `design/` are migration sources, not current authority unless a current document explicitly names one.
