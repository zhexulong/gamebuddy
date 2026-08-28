export type StaticArtifactManifestAsset = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  mime: "text/javascript" | "text/css" | "image/svg+xml" | "image/png" | "image/webp" | "font/woff2";
}>;

export type StaticArtifactManifest = Readonly<{
  schemaVersion: 1;
  browserContract: string;
  profileId: string;
  entryHtml: "index.html";
  assets: readonly StaticArtifactManifestAsset[];
}>;

export type StaticArtifactManifestIdentity = Readonly<{
  manifestFile: string;
  browserContract: string;
  profileId: string;
}>;

export type StaticArtifactInspectionPolicy = Readonly<{
  inspect(absolutePath: string): Promise<void>;
}>;

export type StaticArtifactManifestPolicy = Readonly<{
  createBuildArtifactInspectionPolicy(): Promise<StaticArtifactInspectionPolicy>;
  createProductionArtifactManifest(artifactRoot: string, policy?: StaticArtifactInspectionPolicy): Promise<StaticArtifactManifest>;
  verifyProductionArtifactManifest(artifactRoot: string, policy?: StaticArtifactInspectionPolicy): Promise<StaticArtifactManifest>;
}>;

export function createStaticArtifactManifestPolicy(identity: StaticArtifactManifestIdentity, sourceModuleUrl: string): StaticArtifactManifestPolicy;
