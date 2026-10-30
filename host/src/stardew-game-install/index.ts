export {
  createWindowsGogInstallationSource,
  parseGogGalaxyLibraryRoots,
  parseGogRegistryGames,
} from "./gog-source.js";
export {
  STARDEW_GAME_EXECUTABLE_FILE,
  STARDEW_MOD_LOADER_MISSING,
  STARDEW_NOT_A_STARDEW_INSTALL,
  STARDEW_SMAPI_EXECUTABLE_FILE,
  createWindowsGogDiscoveryProposal,
  discoverStardewGameInstallation,
  probeStardewGameRoot,
  requireStardewGameInstalled,
  requireStardewModLoaderInstalled,
  resolveStardewGameInstallation,
  type StardewGameInstallationResolverInput,
  type StardewGameRootProbe,
} from "./discovery.js";
export {
  deploySmapiPayload,
  type SmapiDeploymentFailure,
  type SmapiDeploymentInput,
  type SmapiDeploymentResult,
} from "./smapi-deployment.js";
export { readSmapiPayload, type SmapiPayload, type SmapiPayloadFile } from "./smapi-payload.js";
export {
  decideStardewCompanionModDeployment,
  deployStardewCompanionMod,
  isCanonicalWindowsDirectory,
  type StardewCompanionModDeploymentFailure,
  type StardewCompanionModDeploymentResult,
  type StardewCompanionModPackage,
  type StardewCompanionModTargetState,
} from "./deployment.js";
