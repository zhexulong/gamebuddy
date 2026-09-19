# M8 Ladder Floor-1 Native Given Fixture — Rejected Route

**Status:** Superseded; do not implement or run.

The former `m8_ladder_given_v1` design used a staged `mine_lowestLevelReached = 1` and a fixed `Game1.warpFarmer("UndergroundMine1", 6, 6, 2)` setup before the independent `use_mine_ladder` action.

Target-version source proves this Given is unreachable without a prohibited extra setup step:

- `Maps/Mines/1.xnb` has no static Buildings-layer tile `173`.
- `MineShaft.populateLevel()` only attempts its initial native ladder branch when `mineLevel > 1`.
- Therefore a fresh unmodified floor-1 generation cannot produce the required existing ladder facility.

The fixture must not retry generation, write map tiles, call ladder-creation methods, or send an action request. The old route is therefore rejected rather than treated as a transient preflight failure.

The replacement, approved direction is `design/86_M8_LADDER_FLOOR_2_NATIVE_GIVEN_IMPLEMENTATION_PLAN.md`: a staged floor-2 progress Given followed by exactly one fixed floor-2 native generation/observation. It remains validation-only, cannot create public capabilities or action evidence, and fails closed if the target game does not generate an observable tile `173` on that one attempt.
