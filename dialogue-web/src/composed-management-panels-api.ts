/**
 * Read-side API for the composed shell's management panels.
 *
 * These use the composed broker's session cookie against the delegated management
 * routes the composed static shell now serves under /api/tavern/v1/. Reads only;
 * every route that mutates is deliberately not mirrored here yet (the panels are
 * read surfaces until a write surface is separately approved).
 *
 * This mirrors the shape of the tavern-management wire contract without importing
 * the management pipeline API: it is a thin, dependency-free fetch client for the
 * exact routes the composed shell mounts.
 */

export type ManageChatEntryV1 = Readonly<{
  handle: string;
  title: string | null;
  status: string;
}>;

export type ManageChatsPanel = Readonly<{ chats: readonly ManageChatEntryV1[] }>;

export type ManageMemoryRowV1 = Readonly<{
  handle: string;
  text: string;
  origin: "player" | "companion";
}>;

export type ManageMemoryPanel = Readonly<{ memories: readonly ManageMemoryRowV1[] }>;

export type ManageWorldInfoEntryV1 = Readonly<{
  handle: string;
  title: string;
  selected: boolean;
}>;

export type ManageWorldInfoPanel = Readonly<{ items: readonly ManageWorldInfoEntryV1[] }>;

export type ManageSettingsPanel = Readonly<{
  language: string;
  voice: "undecided" | "accepted" | "revoked";
}>;

export type ManagementPanelsApi = Readonly<{
  readChats(): Promise<ManageChatsPanel>;
  readMemory(): Promise<ManageMemoryPanel>;
  readWorldInfo(): Promise<ManageWorldInfoPanel>;
  readSettings(): Promise<ManageSettingsPanel>;
}>;

async function readJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as Readonly<{ code?: string }> | null;
    throw new Error(problem?.code ?? `http_${response.status}`);
  }
  return response.json();
}

function asChats(value: unknown): ManageChatsPanel {
  const body = value as Readonly<{ chats?: unknown }>;
  if (!Array.isArray(body.chats)) throw new Error("invalid_response");
  const chats = body.chats.map((entry) => {
    const row = entry as Readonly<{ handle?: unknown; title?: unknown; status?: unknown }>;
    if (typeof row.handle !== "string" || (row.title !== null && typeof row.title !== "string") || typeof row.status !== "string")
      throw new Error("invalid_response");
    return { handle: row.handle, title: row.title, status: row.status };
  });
  return { chats };
}

function asMemory(value: unknown): ManageMemoryPanel {
  const body = value as Readonly<{ memories?: unknown }>;
  if (!Array.isArray(body.memories)) throw new Error("invalid_response");
  const memories = body.memories.map((entry) => {
    const row = entry as Readonly<{ handle?: unknown; text?: unknown; origin?: unknown }>;
    if (
      typeof row.handle !== "string" ||
      typeof row.text !== "string" ||
      (row.origin !== "player" && row.origin !== "companion")
    )
      throw new Error("invalid_response");
    const rawOrigin = row.origin;
    if (rawOrigin !== "player" && rawOrigin !== "companion") throw new Error("invalid_response");
    const origin: ManageMemoryRowV1["origin"] = rawOrigin;
    return { handle: row.handle, text: row.text, origin };
  });
  return { memories };
}

function asWorldInfo(value: unknown): ManageWorldInfoPanel {
  const body = value as Readonly<{ items?: unknown }>;
  if (!Array.isArray(body.items)) throw new Error("invalid_response");
  const items = body.items.map((entry) => {
    const row = entry as Readonly<{ handle?: unknown; title?: unknown; selected?: unknown }>;
    if (typeof row.handle !== "string" || typeof row.title !== "string" || typeof row.selected !== "boolean")
      throw new Error("invalid_response");
    return { handle: row.handle, title: row.title, selected: row.selected };
  });
  return { items };
}

function asSettings(value: unknown): ManageSettingsPanel {
  const body = value as Readonly<{ locale?: unknown; consent?: unknown }>;
  const voice = body.consent === "accepted" || body.consent === "revoked" || body.consent === "undecided" ? body.consent : "undecided";
  return {
    language: typeof body.locale === "string" ? body.locale : "en-US",
    voice,
  };
}

export function createComposedManagementPanelsApi(): ManagementPanelsApi {
  return Object.freeze({
    async readChats(): Promise<ManageChatsPanel> {
      return asChats(await readJson("/api/tavern/v1/chats"));
    },
    async readMemory(): Promise<ManageMemoryPanel> {
      return asMemory(await readJson("/api/tavern/v1/memory"));
    },
    async readWorldInfo(): Promise<ManageWorldInfoPanel> {
      return asWorldInfo(await readJson("/api/tavern/v1/world-info"));
    },
    async readSettings(): Promise<ManageSettingsPanel> {
      return asSettings(await readJson("/api/tavern/v1/settings/voice-preference"));
    },
  });
}