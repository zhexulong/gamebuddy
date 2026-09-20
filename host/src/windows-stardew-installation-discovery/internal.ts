import { randomBytes } from "node:crypto";

export const STARDEW_APP_ID = "413150" as const;
export type StardewInstallationCandidate = Readonly<{ candidateId: string; source: "steam-registry" | "steam-vdf" | "known-location"; label: string; displayPath: string; status: "candidate" | "invalid" | "admission_required" }>;
export type DiscoveryDiagnostic = "registry-unavailable" | "vdf-unreadable" | "vdf-malformed" | "invalid-app-manifest" | "no-candidates" | "source-unavailable" | "candidate-invalid";
export type StardewInstallationDiscoveryResult = Readonly<{ candidates: readonly StardewInstallationCandidate[]; diagnostics: readonly DiscoveryDiagnostic[] }>;

type Proposal = Readonly<{ sessionId: string; candidateId: string; root: string; expiresAt: number; used: boolean }>;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\(?:[^\\/:*?"<>|\u0000-\u001f]+\\?)*$/;
const validPath = (value: string): boolean => WINDOWS_ABSOLUTE.test(value) && !value.endsWith("\\");
const opaque = (): string => randomBytes(24).toString("base64url");

export class StardewDiscoverySession {
  readonly sessionId = opaque();
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly now = () => Date.now()) {}
  issue(source: StardewInstallationCandidate["source"], root: string): StardewInstallationCandidate {
    if (!validPath(root)) throw new Error("candidate-invalid");
    const candidateId = opaque();
    this.proposals.set(candidateId, { sessionId: this.sessionId, candidateId, root, expiresAt: this.now() + this.ttlMs, used: false });
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

export function parseLibraryFoldersVdf(text: string): string[] {
  if (!text.includes("libraryfolders")) throw new Error("vdf-malformed");
  return [...text.matchAll(/"path"\s*"((?:\\.|[^"])*)"/gi)].map((m) => (m[1] ?? "").replace(/\\\\/g, "\\").replace(/\\"/g, '"')).filter(validPath);
}
export function parseAppManifest(text: string): string | null {
  const appid = text.match(/"appid"\s*"(\d+)"/i)?.[1];
  const installDir = text.match(/"installdir"\s*"([^"]+)"/i)?.[1];
  return appid === STARDEW_APP_ID && installDir === "Stardew Valley" ? installDir : null;
}
export function issueBoundCandidate(session: StardewDiscoverySession, source: StardewInstallationCandidate["source"], installRoot: string, manifest: string): StardewInstallationCandidate | undefined {
  return parseAppManifest(manifest) === null ? undefined : session.issue(source, installRoot);
}

/** The single normalization boundary for already verified, source-bound roots. */
export function normalizeBoundCandidates(
  session: StardewDiscoverySession,
  roots: readonly (readonly [StardewInstallationCandidate["source"], string])[],
): readonly StardewInstallationCandidate[] {
  const seen = new Set<string>();
  const normalized = roots
    .filter(([, root]) => {
      const key = root.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(([sourceA, rootA], [sourceB, rootB]) =>
      `${sourceA}\u0000${rootA.toLowerCase()}`.localeCompare(`${sourceB}\u0000${rootB.toLowerCase()}`),
    );
  return Object.freeze(normalized.map(([source, root]) => session.issue(source, root)));
}
const APPROVED_KNOWN_LOCATIONS: readonly string[] = [];

export function discoverCandidates(input: Readonly<{ registryPath?: string; vdf?: string; manifest?: string; session?: StardewDiscoverySession }>): StardewInstallationDiscoveryResult {
  const diagnostics: DiscoveryDiagnostic[] = []; const session = input.session ?? new StardewDiscoverySession(); const roots: Array<readonly [StardewInstallationCandidate["source"], string]> = [];
  const manifestValid = input.manifest !== undefined && parseAppManifest(input.manifest) !== null;
  if (input.registryPath && validPath(input.registryPath)) { if (manifestValid) roots.push(["steam-registry", input.registryPath]); else diagnostics.push("invalid-app-manifest"); } else if (input.registryPath !== undefined) diagnostics.push("registry-unavailable");
  if (input.vdf !== undefined) { try { for (const root of parseLibraryFoldersVdf(input.vdf)) { if (manifestValid) roots.push(["steam-vdf", `${root}\\steamapps\\common\\Stardew Valley`]); else diagnostics.push("invalid-app-manifest"); } } catch { diagnostics.push("vdf-malformed"); } }
  for (const root of APPROVED_KNOWN_LOCATIONS) if (validPath(root) && manifestValid) roots.push(["known-location", root]);
  const candidates = normalizeBoundCandidates(session, roots);
  if (!candidates.length) diagnostics.push("no-candidates");
  return Object.freeze({ candidates: Object.freeze(candidates), diagnostics: Object.freeze(diagnostics) });
}
