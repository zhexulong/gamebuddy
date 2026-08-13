using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// A one-shot, title-screen-only request into Stardew 1.6.15's native loader
/// for a pre-observed isolated Portfolio slot. It does not create, edit, save,
/// or reopen a world; after the target game raises SaveLoaded, normal
/// Portfolio binding owns validation and the bridge is allowed to open.
/// </summary>
public sealed partial class ModEntry
{
    private bool portfolioInitialNativeLoadInvoked;
    private bool portfolioInitialNativeLoadTerminal;
    private bool portfolioInitialNativeLoadSucceeded;

    private void TryLoadPortfolioInitialNativeSave()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioInitialNativeLoadConfig? initialLoad = portfolio?.InitialNativeLoad;
        if (portfolio is null || initialLoad is not { Enable: true } || this.portfolioInitialNativeLoadTerminal)
            return;
        if (!portfolio.IsValid || !initialLoad.IsValid)
        {
            this.portfolioInitialNativeLoadTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio initial native load configuration.", LogLevel.Error);
            return;
        }
        if (this.portfolioInitialNativeLoadInvoked)
            return;
        if (Context.IsWorldReady || Game1.hasLoadedGame)
        {
            this.portfolioInitialNativeLoadTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio initial native load because a world is already loaded.", LogLevel.Error);
            return;
        }

        try
        {
            this.portfolioInitialNativeLoadInvoked = true;
            SaveGame.Load(initialLoad.ObservedSaveSlot);
            Game1.exitActiveMenu();
            this.Monitor.Log("GameBuddy requested initial native Portfolio save load; awaiting original SaveLoaded.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.portfolioInitialNativeLoadTerminal = true;
            this.Monitor.Log($"GameBuddy Portfolio initial native load failed: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private PortfolioInitialNativeLoadCompletion TryCompletePortfolioInitialNativeLoad()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioInitialNativeLoadConfig? initialLoad = portfolio?.InitialNativeLoad;
        if (portfolio is null || initialLoad is not { Enable: true })
            return PortfolioInitialNativeLoadCompletion.NotArmed;
        if (!portfolio.IsValid || !initialLoad.IsValid || !Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null
            || Context.IsMultiplayer || !Game1.IsMasterGame)
        {
            this.portfolioInitialNativeLoadTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio initial native load completion because the native local world is invalid.", LogLevel.Error);
            return PortfolioInitialNativeLoadCompletion.Rejected;
        }
        string observed = $"{Game1.GetSaveGameName(set_value: false)}_{Game1.uniqueIDForThisGame}";
        if (!String.Equals(observed, initialLoad.ObservedSaveSlot, StringComparison.Ordinal))
        {
            this.portfolioInitialNativeLoadTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio initial native load completion because the observed slot differs.", LogLevel.Error);
            return PortfolioInitialNativeLoadCompletion.Rejected;
        }

        PortfolioConfig completed = new()
        {
            Enable = true,
            Topology = portfolio.Topology,
            EnableObserveBridge = portfolio.EnableObserveBridge,
            EnabledActions = portfolio.EnabledActions,
            PipeName = portfolio.PipeName,
            BridgeToken = portfolio.BridgeToken,
            SaveId = Game1.uniqueIDForThisGame.ToString(),
            WorldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(),
            LocalPlayerId = Game1.player.UniqueMultiplayerID.ToString(),
            CompanionId = portfolio.CompanionId,
            DataRoot = portfolio.DataRoot,
            ExpectedGameVersion = portfolio.ExpectedGameVersion,
            ExpectedGameBuildNumber = portfolio.ExpectedGameBuildNumber,
            Bootstrap = portfolio.Bootstrap,
            InitialNativeLoad = new PortfolioInitialNativeLoadConfig { Enable = false, ObservedSaveSlot = initialLoad.ObservedSaveSlot },
            P0bLifecycleProducer = portfolio.P0bLifecycleProducer,
        };
        if (!completed.IsValid)
        {
            this.portfolioInitialNativeLoadTerminal = true;
            this.Monitor.Log("GameBuddy rejected Portfolio initial native load completion because its disarmed config is invalid.", LogLevel.Error);
            return PortfolioInitialNativeLoadCompletion.Rejected;
        }
        this.config = new ModConfig { Portfolio = completed };
        this.Helper.WriteConfig(this.config);
        this.portfolioInitialNativeLoadSucceeded = true;
        this.portfolioInitialNativeLoadTerminal = true;
        this.Monitor.Log("GameBuddy observed Portfolio initial native load and recorded current native local-player scope; opening bridge.", LogLevel.Info);
        return PortfolioInitialNativeLoadCompletion.Succeeded;
    }

    private enum PortfolioInitialNativeLoadCompletion
    {
        NotArmed,
        Rejected,
        Succeeded,
    }
}
