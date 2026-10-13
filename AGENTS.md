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
- For product architecture, domain behavior, ADRs, active implementation tasks, research, or historical design, read the private `zhexulong/gamebuddy-docs` repository mounted locally at `design/`; start at `design/README.md` and follow its current-owner links. Numbered root files under `design/` are migration sources, not current authority unless a current document explicitly names one.
