export {
  createWindowsGogInstallationSource,
  parseGogGalaxyLibraryRoots,
  parseGogRegistryGames,
} from "./gog-source.js";
export {
  STARDEW_GAME_EXECUTABLE_FILE,
  STARDEW_MOD_LOADER_MISSING,
  STARDEW_SMAPI_EXECUTABLE_FILE,
  discoverStardewGameInstallation,
  probeStardewGameRoot,
  requireStardewModLoaderInstalled,
  resolveStardewGameInstallation,
  type StardewGameInstallationResolverInput,
  type StardewGameRootProbe,
} from "./discovery.js";
export {
  decideStardewCompanionModDeployment,
  deployStardewCompanionMod,
  isCanonicalWindowsDirectory,
  type StardewCompanionModDeploymentFailure,
  type StardewCompanionModDeploymentResult,
  type StardewCompanionModPackage,
  type StardewCompanionModTargetState,
} from "./deployment.js";
