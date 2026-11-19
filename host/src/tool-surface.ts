import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * What a tool can do, and therefore which companion surface may mount it.
 *
 * <p>
 * The safety intent that made every companion session start from `noTools: "all"` is right: the companion must
 * not inherit Pi's Shell, filesystem, Git or network tools. What was wrong was the expression of it. The runtime
 * kept a hand-written list of tool NAMES in a file far from where each tool is defined, so adding one read-only
 * session tool meant editing that list, and forgetting was silent - the tool was simply absent. This module
 * replaces the list with a class per definition.
 * </p>
 *
 * <p>
 * Membership is derived, never spelled: a Host-authored tool is classified by the group the composition
 * assembles it in (`DeclaredToolGroup`), and an extension's tools are classified by the extension that
 * registered them, read from the loader's own provenance. Neither path names a tool, so a tool added to one of
 * those sources mounts on every surface that permits its class without any edit here.
 * </p>
 */
export const TOOL_CAPABILITY_CLASSES = Object.freeze([
  /** Dispatches into, or reads, the live game world through the mounted integration. */
  "game_action",
  /** The Host's own program surface: the plan builder, its status and its event stream. */
  "program",
  /** Authored context a companion reads: the world book, and an integration's own knowledge bundle. */
  "world_context",
  /** A session's own archive and memory - the Magic Context `ctx_*` family. */
  "session_inspection",
  /** Host status and notices. */
  "host_control",
  /** Reads or writes the filesystem. Never a companion capability. */
  "filesystem",
  /** Runs a shell. Never a companion capability. */
  "shell",
  /** Edits files through a code editor. Never a companion capability. */
  "editor",
  /** Reaches the network outside the Host's own provider path. Never a companion capability. */
  "network",
  /** Declared by no source this surface knows. The default for anything unaccounted for. */
  "unknown",
] as const);

export type ToolCapabilityClass = (typeof TOOL_CAPABILITY_CLASSES)[number];

/**
 * The classes no companion surface may ever mount, whatever a surface's table says.
 *
 * `unknown` is here because an unclassified tool is one nothing vouched for: fail closed and name it, rather
 * than mounting it because its class was merely not recognised.
 */
export const DENIED_TOOL_CLASSES = Object.freeze([
  "filesystem",
  "shell",
  "editor",
  "network",
  "unknown",
] as const) satisfies readonly ToolCapabilityClass[];

export type CompanionSurface = "game" | "chat";

/**
 * What each surface permits, declared by class and never by name.
 *
 * Game is the play surface: it acts on the world, reads authored context, and may read the session's own
 * history. Chat is a pure dialogue surface - it has no world and no action vocabulary, so it permits nothing
 * but Host status.
 */
export const PERMITTED_TOOL_CLASSES: Readonly<Record<CompanionSurface, readonly ToolCapabilityClass[]>> = Object.freeze(
  {
    game: Object.freeze(["game_action", "program", "world_context", "session_inspection", "host_control"] as const),
    chat: Object.freeze(["host_control"] as const),
  },
);

for (const [surface, permitted] of Object.entries(PERMITTED_TOOL_CLASSES)) {
  const contradictory = permitted.filter((toolClass) =>
    (DENIED_TOOL_CLASSES as readonly ToolCapabilityClass[]).includes(toolClass),
  );
  if (contradictory.length > 0)
    throw new Error(`companion_surface_permits_denied_tool_class:${surface}:${contradictory.join(",")}`);
}

/** The tools one composition assembles, with the classification that composition declares for the group. */
export type DeclaredToolGroup = Readonly<{
  toolClass: ToolCapabilityClass;
  tools: readonly ToolDefinition[];
}>;

/** One extension the Host loads, and the class every tool it registers carries. */
export type DeclaredExtension = Readonly<{
  /** The extension entry the Host hands to the loader; it must be the path the loader reports back. */
  entry: string;
  toolClass: ToolCapabilityClass;
}>;

/*
 * WHAT THIS MODULE DOES NOT DO: IT DOES NOT WRITE A TOOL'S DESCRIPTION.
 *
 * <p>
 * It used to, keyed by CAPABILITY CLASS. One paragraph replaced the description of every tool in that class on the Game
 * surface, because the Magic Context extension writes for a coding agent - `ctx_search` is "everything that ever happened
 * in this project" - and the Game surface is where a farmhand who has just forgotten her own morning reads it. That was
 * refused, and the mechanism was the worse half: keyed by class it rewrote tools its author never saw, so a tool the
 * extension registered tomorrow arrived carrying a sentence written before it existed, and nothing in the tree could
 * notice.
 * </p>
 *
 * <p>
 * THE ONE WRITER IS NAMED AND NARROW: `companion-archive-tool-descriptions.ts` projects exactly TWO tools, by name, each
 * with its own sentence, and its subject is this surface - her own memory of this world rather than a repository's history.
 * That is the opposite policy in the two ways that mattered: NAMED, not classed, so no tool the table does not name is
 * touched; and TWO, not every tool of a class, so the projection cannot blur a family into one voice. Each entry carries
 * its own `why`, so a third name has to say what it is doing on this surface. The mechanics stay the tools' - what is
 * replaced is the audience and the examples, which the extension cannot know because it does not know which surface mounts
 * it. `tool-surface.private.test.ts` holds both halves.
 * </p>
 */

/** What an extension actually registered, as the loader reports it before any session exists. */
export type RegisteredExtensionTools = Readonly<{
  entry: string;
  tools: readonly string[];
}>;

/** This surface's mounting decision: the allowlist, and the class behind each name. */
export type ToolSurfacePlan = Readonly<{
  surface: CompanionSurface;
  /** Every tool name this surface mounts, sorted. The provider allowlist is exactly this set. */
  mounted: readonly string[];
  /** The class each planned name carries. A mounted name absent here is `unknown`. */
  classOf: Readonly<Record<string, ToolCapabilityClass>>;
}>;

/** The class a name carries on this plan, or `unknown` when nothing declared it. */
export function toolClassOf(plan: ToolSurfacePlan, name: string): ToolCapabilityClass {
  return plan.classOf[name] ?? "unknown";
}

/**
 * Build one surface's mounting decision from definitions and loader provenance.
 *
 * An extension tool is classified by the extension that registered it: the Host declares a class per loaded
 * extension, so a new tool inside that extension arrives already classified. An extension whose tools the Host never
 * declared is refused here, naming the extension and every tool it offered - a loaded extension the surface cannot
 * classify is a defect in the composition, not something to drop quietly. A mounted name nothing declared is `unknown`,
 * which every surface refuses, and `assertToolSurface` names it.
 */
export function planToolSurface(
  input: Readonly<{
    surface: CompanionSurface;
    groups: readonly DeclaredToolGroup[];
    extensions: readonly DeclaredExtension[];
    registered: readonly RegisteredExtensionTools[];
  }>,
): ToolSurfacePlan {
  const permitted = PERMITTED_TOOL_CLASSES[input.surface];
  const classOf = new Map<string, ToolCapabilityClass>();
  const declare = (name: string, toolClass: ToolCapabilityClass, source: string): void => {
    const declared = classOf.get(name);
    if (declared !== undefined) throw new Error(`runtime_tool_name_collision:${name}:${declared},${source}`);
    classOf.set(name, toolClass);
  };

  for (const group of input.groups) {
    for (const tool of group.tools) declare(tool.name, group.toolClass, group.toolClass);
  }
  const declaredExtensions = new Map(input.extensions.map((extension) => [extension.entry, extension.toolClass]));
  for (const registered of input.registered) {
    const declared = declaredExtensions.get(registered.entry);
    if (declared === undefined) {
      // An extension that registered tools and whose class the Host never declared is refused here, naming the
      // extension and every tool it tried to offer. Mounting them as `unknown` would be a silent refusal of exactly
      // the kind this module exists to end: the tools would simply not be there, and nothing would say why.
      if (registered.tools.length > 0)
        throw new Error(
          `companion_extension_tool_class_undeclared:${registered.entry}:${[...registered.tools].sort().join(",")}`,
        );
      continue;
    }
    for (const name of registered.tools) declare(name, declared, registered.entry);
  }

  const mounted = [...classOf.keys()]
    .filter((name) => permitted.includes(classOf.get(name) as ToolCapabilityClass))
    .sort();
  return Object.freeze({
    surface: input.surface,
    mounted: Object.freeze(mounted),
    classOf: Object.freeze(Object.fromEntries(classOf)),
  });
}

/**
 * Assert the property: what is mounted is what this surface permits, and what it planned is what mounted.
 *
 * This replaces an assertion that compared the mounted set to a hand-kept list for EQUALITY. That comparison
 * could only ever say "the list and the session disagree"; it could not say which name was dangerous, and it
 * could not admit a tool the list had never heard of. The property is three claims, each naming its offender:
 * every mounted tool's class is permitted here, no denied-class tool is mounted, and every planned name mounted
 * (unless it declared itself inactive for this run).
 */
export function assertToolSurface(
  plan: ToolSurfacePlan,
  mountedNames: readonly string[],
  inactiveNames: readonly string[] = [],
): void {
  const permitted = PERMITTED_TOOL_CLASSES[plan.surface];
  const mounted = new Set(mountedNames);
  const describe = (name: string): string => `${name} (class ${toolClassOf(plan, name)})`;

  const notPermitted = mountedNames.filter((name) => !permitted.includes(toolClassOf(plan, name)));
  const denied = mountedNames.filter((name) =>
    (DENIED_TOOL_CLASSES as readonly ToolCapabilityClass[]).includes(toolClassOf(plan, name)),
  );
  const inactive = new Set(inactiveNames);
  const missing = plan.mounted.filter((name) => !(mounted.has(name) || inactive.has(name)));

  if (notPermitted.length === 0 && denied.length === 0 && missing.length === 0) return;
  const parts = [
    notPermitted.length === 0
      ? ""
      : `not permitted on the ${plan.surface} surface: ${notPermitted.map(describe).join(", ")}`,
    denied.length === 0 ? "" : `denied class mounted: ${denied.map(describe).join(", ")}`,
    missing.length === 0 ? "" : `declared but not mounted: ${missing.map(describe).join(", ")}`,
    `mounted ${mountedNames.length}: ${[...mountedNames].sort().map(describe).join(", ") || "(none)"}`,
  ].filter((part) => part.length > 0);
  throw new Error(`Companion tool isolation failed: ${parts.join("; ")}`);
}
