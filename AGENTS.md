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
