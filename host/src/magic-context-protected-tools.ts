/**
 * The Host's `protected_tools` policy for the Game surface.
 *
 * Upstream made automatic ("smart") drops unconditional in 0.46.0: a tool result a later call
 * supersedes is reclaimed on any pass that rebuilds the cache. Its answer is `protected_tools`, a map
 * from tool name to how many of that tool's NEWEST still-active results every automatic drop lane must
 * leave alone. It is a rolling window, not permanence — newer results displace older ones, and a
 * dropped or historian-summarised result stops occupying its slot. Upstream merges this map over its
 * own defaults `{todowrite: 1, ctx_reduce: 3}`, and `0` switches a default off; protection is honoured
 * even at >=95% context pressure and has no byte cap.
 *
 * One frame per perception tool (`N = 1`). A single observation is 800-1500 tokens, so `N = 1` keeps
 * "the world a moment ago" in front of the model while every older frame rotates out; anything larger
 * accumulates linearly. What actually removes old observations is the threshold-driven reclaim (age,
 * emergency, tail hygiene), and every one of those lanes honours this map.
 *
 * The two upstream defaults are named explicitly with `0` rather than left out: they belong to
 * upstream's coding-agent surface, and a name this surface never uses would otherwise keep protecting
 * results we do not produce. Every other key is a tool the Host itself registers — `magic-context-
 * protected-tools.test.ts` derives that set from the tool modules, so a rename cannot silently drop
 * protection.
 */
export const GAMEBUDDY_PROTECTED_TOOLS: Readonly<Record<string, number>> = Object.freeze({
  stardew_observe: 1,
  stardew_read_scene: 1,
  stardew_find_destination: 1,
  stardew_inspect_world_map: 1,
  stardew_game_knowledge: 1,
  companion_worldbook_query: 1,
  companion_status: 1,
  todowrite: 0,
  ctx_reduce: 0,
});

/**
 * The table as one run should use it.
 *
 * `disabled` exists for the paired live measurement the owner ruling owes: the effect of this policy can only be
 * seen by comparing a session that reaches reclaim pressure with the policy against one without it, and there is
 * no product-level way to switch it off - the Host always writes the key. Zeroing every entry protects nothing
 * while keeping the key's shape, so the control arm differs in exactly one thing. It is a fixture channel, opt-in
 * by environment, and it says on stderr when it is used.
 */
export function protectedToolsForRun(disabled: boolean): Readonly<Record<string, number>> {
  if (!disabled) return GAMEBUDDY_PROTECTED_TOOLS;
  return Object.freeze(Object.fromEntries(Object.keys(GAMEBUDDY_PROTECTED_TOOLS).map((name) => [name, 0])));
}
