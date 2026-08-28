using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// One-shot, title-screen-only setup for an isolated Portfolio save.
///
/// This is deliberately not a fixture initializer or a gameplay capability:
/// it only invokes Stardew's normal new-character completion entrypoint after
/// supplying the three creation fields needed by that entrypoint. Stardew then
/// owns new-game initialization and saving. No save XML, debug command, UI/OS
/// input, receipt, milestone state, or action target is written here.
/// </summary>
public sealed partial class ModEntry
{
    private bool portfolioBootstrapInvoked;
    private bool portfolioBootstrapTerminal;

    private bool IsPortfolioBootstrapArmed => this.config.Portfolio?.Bootstrap is { Enable: true };

    private void TryBootstrapPortfolioNativeSave()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioBootstrapConfig? bootstrap = portfolio?.Bootstrap;
        if (portfolio is null || bootstrap is null || !bootstrap.Enable || this.portfolioBootstrapTerminal)
            return;
        if (!portfolio.IsBootstrapValid)
        {
            this.portfolioBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio bootstrap configuration; no save was created.", LogLevel.Error);
            return;
        }
        if (this.portfolioBootstrapInvoked)
            return;
        if (Context.IsWorldReady || Game1.hasLoadedGame)
        {
            this.portfolioBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio bootstrap because a world is already loaded; it only runs at the native title screen.", LogLevel.Error);
            return;
        }
        if (Game1.activeClickableMenu is not TitleMenu titleMenu)
            return;
        if (SaveGame.IsNewGameSaveNameCollision(bootstrap.SaveName))
        {
            this.portfolioBootstrapTerminal = true;
            this.Monitor.Log($"GameBuddy rejected Portfolio bootstrap because native save name '{bootstrap.SaveName}' already exists.", LogLevel.Error);
            return;
        }

        try
        {
            // Mirror the native TitleMenu → CharacterCustomization new-game
            // handoff, but provide typed setup input rather than OS/UI events.
            // TitleMenu.createdNewCharacter(true) remains the target-version
            // owner of loadForNewGame, NewDay, and the initial native save.
            Game1.resetPlayer();
            // SaveGame.Save derives the native slot from the current logical
            // save name plus its generated unique game ID. Set that native
            // logical value explicitly; Farmer.Name remains character data.
            Game1.SetSaveName(bootstrap.SaveName);
            Game1.player.Name = bootstrap.PlayerName;
            // Target-version createdNewCharacter() derives the native save
            // name from MasterPlayer.farmName after loadForNewGame resets
            // the transient Game1 save-name override.
            Game1.player.farmName.Value = bootstrap.SaveName;
            Game1.player.favoriteThing.Value = "Portfolio";
            string resolvedSaveName = Game1.GetSaveGameName(set_value: false);
            if (!String.Equals(resolvedSaveName, bootstrap.SaveName, StringComparison.Ordinal))
            {
                this.portfolioBootstrapTerminal = true;
                this.Monitor.Log("GameBuddy rejected Portfolio bootstrap because the native save-name resolver did not preserve the requested isolated prefix.", LogLevel.Error);
                return;
            }

            this.portfolioBootstrapInvoked = true;
            titleMenu.createdNewCharacter(skipIntro: true);
            this.Monitor.Log($"GameBuddy requested native Portfolio new-game lifecycle for '{bootstrap.SaveName}'; waiting for original SaveLoaded before recording scope.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.portfolioBootstrapTerminal = true;
            this.Monitor.Log($"GameBuddy Portfolio bootstrap failed before native save completion: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private bool TryCompletePortfolioBootstrap()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioBootstrapConfig? bootstrap = portfolio?.Bootstrap;
        if (portfolio is null || bootstrap is not { Enable: true })
            return false;
        if (!portfolio.IsBootstrapValid || !Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null || Context.IsMultiplayer || !Game1.IsMasterGame)
        {
            this.portfolioBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio bootstrap completion because the resulting world is not a native single-player local-player world.", LogLevel.Error);
            return false;
        }
        if (!String.Equals(Game1.GetSaveGameName(set_value: false), bootstrap.SaveName, StringComparison.Ordinal))
        {
            this.portfolioBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio bootstrap completion because the loaded native save name differs from the requested isolated name.", LogLevel.Error);
            return false;
        }

        PortfolioConfig completed = new()
        {
            Enable = true,
            Topology = portfolio.Topology,
            EnableObserveBridge = portfolio.EnableObserveBridge,
            PipeName = portfolio.PipeName,
            BridgeToken = portfolio.BridgeToken,
            SaveId = Game1.uniqueIDForThisGame.ToString(),
            WorldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(),
            LocalPlayerId = Game1.player.UniqueMultiplayerID.ToString(),
            CompanionId = portfolio.CompanionId,
            DataRoot = portfolio.DataRoot,
            ExpectedGameVersion = portfolio.ExpectedGameVersion,
            ExpectedGameBuildNumber = portfolio.ExpectedGameBuildNumber,
            P0bLifecycleProducer = portfolio.P0bLifecycleProducer,
            Bootstrap = new PortfolioBootstrapConfig
            {
                Enable = false,
                SaveName = bootstrap.SaveName,
                PlayerName = bootstrap.PlayerName,
            },
        };
        if (!completed.IsValid)
        {
            this.portfolioBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio bootstrap completion because the observed native scope cannot form a valid Portfolio configuration.", LogLevel.Error);
            return false;
        }

        this.config = new ModConfig
        {
            // A Portfolio profile must not retain a usable Farmhand configuration.
            // The root fields remain serializer-compatible defaults, but the
            // Portfolio branch above never reads or activates them.
            EnableLocalBridge = false,
            PipeName = string.Empty,
            BridgeToken = string.Empty,
            SaveId = string.Empty,
            WorldId = string.Empty,
            PlayerId = string.Empty,
            CompanionId = string.Empty,
            Portfolio = completed,
            ActionPolicyVersion = 0,
            DeniedActions = new List<string>(),
            DeniedActionFamilies = new List<string>(),
            ExperimentalActions = new List<string>(),
            EnabledActions = new List<string>(),
        };
        this.Helper.WriteConfig(this.config);
        this.portfolioBootstrapTerminal = true;
        this.Monitor.Log($"GameBuddy recorded native Portfolio local-player scope for '{bootstrap.SaveName}' and disarmed bootstrap; a separate native reopen/save attestation is still required.", LogLevel.Info);
        return true;
    }
}
