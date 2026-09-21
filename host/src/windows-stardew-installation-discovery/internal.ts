import { randomBytes } from "node:crypto";

export const STARDEW_APP_ID = "413150" as const;
export const WINDOWS_PATH_MAX_LENGTH = 32_767;
export const STEAM_METADATA_MAX_BYTES = 4 * 1024 * 1024;
export type StardewInstallationCandidate = Readonly<{ candidateId: string; source: "steam-registry" | "steam-vdf" | "known-location"; label: string; displayPath: string; status: "candidate" | "invalid" | "admission_required" }>;
export type DiscoveryDiagnostic = "registry-unavailable" | "vdf-unreadable" | "vdf-malformed" | "invalid-app-manifest" | "no-candidates" | "source-unavailable" | "candidate-invalid";
export type StardewInstallationDiscoveryResult = Readonly<{ candidates: readonly StardewInstallationCandidate[]; diagnostics: readonly DiscoveryDiagnostic[] }>;

type Proposal = Readonly<{ sessionId: string; candidateId: string; root: string; expiresAt: number; used: boolean }>;
type VdfValue = Readonly<{ kind: "value"; value: string }> | Readonly<{ kind: "object"; entries: readonly VdfEntry[] }>;
type VdfEntry = Readonly<{ key: string; value: VdfValue }>;
type VdfToken = Readonly<{ kind: "string" | "open" | "close"; value?: string }>;

/** Normalize only absolute drive paths; do not repair traversal or ambiguous locators. */
export function normalizeWindowsPath(value: string): string | undefined {
  if (value.length === 0 || value.length > WINDOWS_PATH_MAX_LENGTH) return undefined;
  // Steam writes forward-slash drive paths (e.g. "d:/steam"); Windows accepts both separators.
  const drivePath = value.replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/.test(drivePath)) return undefined;
  const parts = drivePath.slice(3).split("\\");
  if (parts.length === 0 || parts.some((part) => part.length === 0 || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || part.endsWith(".") || part.endsWith(" "))) return undefined;
  const normalized = `${drivePath.charAt(0).toUpperCase()}:\\${parts.join("\\")}`;
  return normalized.length <= WINDOWS_PATH_MAX_LENGTH ? normalized : undefined;
}

const opaque = (): string => randomBytes(24).toString("base64url");

export class StardewDiscoverySession {
  readonly sessionId = opaque();
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly now = () => Date.now()) {}
  issue(source: StardewInstallationCandidate["source"], root: string): StardewInstallationCandidate {
    const normalizedRoot = normalizeWindowsPath(root);
    if (normalizedRoot === undefined || normalizedRoot.endsWith("\\")) throw new Error("candidate-invalid");
    const candidateId = opaque();
    this.proposals.set(candidateId, { sessionId: this.sessionId, candidateId, root: normalizedRoot, expiresAt: this.now() + this.ttlMs, used: false });
    return Object.freeze({ candidateId, source, label: "Stardew Valley", displayPath: "Detected installation (path hidden)", status: "admission_required" });
  }
  reset(): void { this.proposals.clear(); }
  consume(candidateId: string, sessionId = this.sessionId): string {
    const proposal = this.proposals.get(candidateId);
    if (!proposal || proposal.sessionId !== sessionId || proposal.used || proposal.expiresAt <= this.now()) throw new Error("candidate-invalid");
    this.proposals.set(candidateId, { ...proposal, used: true });
    return proposal.root;
  }
}

function readVdfTokens(text: string): readonly VdfToken[] {
  const tokens: VdfToken[] = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] !== undefined && /\s/.test(text[index]!)) index += 1;
    if (index >= text.length) break;
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
      continue;
    }
    if (text[index] === "{") { tokens.push({ kind: "open" }); index += 1; continue; }
    if (text[index] === "}") { tokens.push({ kind: "close" }); index += 1; continue; }
    if (text[index] !== '"') throw new Error("vdf-malformed");
    index += 1;
    let value = "";
    let closed = false;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') { index += 1; closed = true; break; }
      if (character === "\\") {
        const escaped = text[index + 1];
        if (escaped !== "\\" && escaped !== '"') throw new Error("vdf-malformed");
        value += escaped;
        index += 2;
        continue;
      }
      value += character;
      index += 1;
    }
    if (!closed) throw new Error("vdf-malformed");
    tokens.push({ kind: "string", value });
  }
  return tokens;
}

function parseVdfEntries(tokens: readonly VdfToken[], start: number, expectClose: boolean): Readonly<{ entries: readonly VdfEntry[]; next: number }> {
  const entries: VdfEntry[] = [];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token?.kind === "close") {
      if (!expectClose) throw new Error("vdf-malformed");
      return { entries: Object.freeze(entries), next: index + 1 };
    }
    if (token?.kind !== "string" || token.value === undefined) throw new Error("vdf-malformed");
    const valueToken = tokens[index + 1];
    if (valueToken?.kind === "string" && valueToken.value !== undefined) {
      entries.push(Object.freeze({ key: token.value, value: Object.freeze({ kind: "value", value: valueToken.value }) }));
      index += 2;
      continue;
    }
    if (valueToken?.kind !== "open") throw new Error("vdf-malformed");
    const nested = parseVdfEntries(tokens, index + 2, true);
    entries.push(Object.freeze({ key: token.value, value: Object.freeze({ kind: "object", entries: nested.entries }) }));
    index = nested.next;
  }
  if (expectClose) throw new Error("vdf-malformed");
  return { entries: Object.freeze(entries), next: index };
}

function parseVdf(text: string): readonly VdfEntry[] {
  const tokens = readVdfTokens(text);
  const parsed = parseVdfEntries(tokens, 0, false);
  if (parsed.next !== tokens.length) throw new Error("vdf-malformed");
  return parsed.entries;
}

function directValue(entries: readonly VdfEntry[], key: string): string | undefined {
  const matches = entries.filter((candidate) => candidate.key.toLowerCase() === key.toLowerCase());
  const entry = matches.length === 1 ? matches[0] : undefined;
  return entry?.value.kind === "value" ? entry.value.value : undefined;
}

function isDecimalKey(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) if (character < "0" || character > "9") return false;
  return true;
}

export function parseLibraryFoldersVdf(text: string): string[] {
  const sections = parseVdf(text);
  const section = sections[0];
  const libraryFolders = section?.value;
  if (sections.length !== 1 || section?.key.toLowerCase() !== "libraryfolders" || libraryFolders?.kind !== "object") throw new Error("vdf-malformed");
  const roots: string[] = [];
  for (const entry of libraryFolders.entries) {
    if (!isDecimalKey(entry.key)) continue;
    if (entry.value.kind !== "object") throw new Error("vdf-malformed");
    const root = directValue(entry.value.entries, "path");
    const normalized = root === undefined ? undefined : normalizeWindowsPath(root);
    if (normalized === undefined) throw new Error("vdf-malformed");
    roots.push(normalized);
  }
  return roots;
}

function findManifestValues(entries: readonly VdfEntry[]): string | null {
  const appId = directValue(entries, "appid");
  const installDir = directValue(entries, "installdir");
  if (appId === STARDEW_APP_ID && installDir === "Stardew Valley") return installDir;
  for (const entry of entries) {
    if (entry.value.kind !== "object") continue;
    const result = findManifestValues(entry.value.entries);
    if (result !== null) return result;
  }
  return null;
}

export function parseAppManifest(text: string): string | null {
  try { return findManifestValues(parseVdf(text)); }
  catch { return null; }
}

/** The single normalization boundary for already verified, source-bound roots. */
export function normalizeBoundCandidates(
  session: StardewDiscoverySession,
  roots: readonly (readonly [StardewInstallationCandidate["source"], string])[],
): readonly StardewInstallationCandidate[] {
  const seen = new Set<string>();
  const normalized = roots
    .map(([source, root]) => [source, normalizeWindowsPath(root)] as const)
    .filter((entry): entry is readonly [StardewInstallationCandidate["source"], string] => entry[1] !== undefined)
    .filter(([, root]) => {
      const key = root.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(([sourceA, rootA], [sourceB, rootB]) => `${sourceA}\u0000${rootA.toLowerCase()}`.localeCompare(`${sourceB}\u0000${rootB.toLowerCase()}`));
  return Object.freeze(normalized.map(([source, root]) => session.issue(source, root)));
}

export function issueBoundCandidate(session: StardewDiscoverySession, source: StardewInstallationCandidate["source"], installRoot: string, manifest: string): StardewInstallationCandidate | undefined {
  return parseAppManifest(manifest) === null ? undefined : session.issue(source, installRoot);
}
