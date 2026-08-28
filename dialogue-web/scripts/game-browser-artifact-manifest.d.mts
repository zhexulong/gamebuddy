export const ARTIFACT_MANIFEST_FILE: "game-browser-artifact-manifest.json";
export const BROWSER_CONTRACT: "game_browser_api/v1";
export const PROFILE_ID: "gamebuddy.game.preview";

export type ProductionArtifactAsset = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  mime: "text/javascript" | "text/css" | "image/svg+xml" | "image/png" | "image/webp" | "font/woff2";
}>;

export type ProductionArtifactManifest = Readonly<{
  schemaVersion: 1;
  browserContract: typeof BROWSER_CONTRACT;
  profileId: typeof PROFILE_ID;
  entryHtml: "index.html";
  assets: readonly ProductionArtifactAsset[];
}>;

export type BrowserArtifactInspectionPolicy = Readonly<{
  inspect(absolutePath: string): Promise<void>;
}>;

export function createBuildArtifactInspectionPolicy(): Promise<BrowserArtifactInspectionPolicy>;
export function createProductionArtifactManifest(artifactRoot: string, policy?: BrowserArtifactInspectionPolicy): Promise<ProductionArtifactManifest>;
export function verifyProductionArtifactManifest(artifactRoot: string, policy?: BrowserArtifactInspectionPolicy): Promise<ProductionArtifactManifest>;
