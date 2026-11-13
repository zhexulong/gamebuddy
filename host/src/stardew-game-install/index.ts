export {
  createWindowsGogInstallationSource,
  parseGogGalaxyLibraryRoots,
  parseGogRegistryGames,
} from "./gog-source.js";
export {
  createWindowsMicrosoftStoreInstallationSource,
  type StardewMicrosoftStoreSource,
  type StardewMicrosoftStoreSourceFacts,
} from "./microsoft-store-source.js";
export {
  STARDEW_GAME_EXECUTABLE_FILE,
  STARDEW_MOD_LOADER_MISSING,
  STARDEW_NOT_A_STARDEW_INSTALL,
  STARDEW_SMAPI_EXECUTABLE_FILE,
  createWindowsGogDiscoveryProposal,
  createWindowsMicrosoftStoreDiscoveryProposal,
  discoverStardewGameInstallation,
  probeStardewGameRoot,
  requireStardewGameInstalled,
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
