import { createStaticArtifactManifestPolicy } from "./static-artifact-manifest-core.mjs";

export const ARTIFACT_MANIFEST_FILE = "game-browser-artifact-manifest.json";
export const BROWSER_CONTRACT = "game_browser_api/v1";
export const PROFILE_ID = "gamebuddy.game.preview";

const policy = createStaticArtifactManifestPolicy({
  manifestFile: ARTIFACT_MANIFEST_FILE,
  browserContract: BROWSER_CONTRACT,
  profileId: PROFILE_ID,
}, import.meta.url);

export const createProductionArtifactManifest = policy.createProductionArtifactManifest;
export const verifyProductionArtifactManifest = policy.verifyProductionArtifactManifest;
