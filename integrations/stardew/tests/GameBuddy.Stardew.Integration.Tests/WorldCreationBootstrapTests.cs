// Tests for the formal Player Host native world-creation lane (Loop 4 path B').
//
// Scope, stated honestly: the native new-game entry itself
// (`TitleMenu.createdNewCharacter`) and the native SaveLoaded completion cannot
// be driven from a unit test — both need a live game with content loaded. These
// tests therefore cover (a) the staged-form validation, (b) every state-machine
// gate that runs BEFORE a native call is reached, and (c) the observed-slot
// format the create path and the join manifest must agree on. What stays
// unverified by this file is called out at the bottom of each test.
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using GameBuddy.Stardew;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class WorldCreationBootstrapTests
{
    private const string Token = "aaaabbbbccccdddd";

    private static WorldCreationConfig StagedForm(bool enable = true, bool createOnce = true) => new()
    {
        Enable = enable,
        FarmName = "GameBuddy Farm",
        PlayerName = "GameBuddy",
        FavoriteThing = "Coffee",
        CreateOnce = createOnce,
    };

    private static WorldCreationConfig Identity(string farmName, string playerName, string favoriteThing) => new()
    {
        Enable = true,
        FarmName = farmName,
        PlayerName = playerName,
        FavoriteThing = favoriteThing,
        CreateOnce = true,
    };

    private static WorldCreationBootstrap CreateBootstrap(WorldCreationConfig? config = null) =>
        new(config ?? StagedForm(), new DummyMonitor());

    // ---- (a) staged-form validation -------------------------------------------------

    [Fact]
    public void StagedForm_IsAccepted()
    {
        StagedForm().IsValid.Should().BeTrue();
    }

    [Fact]
    public void StagedForm_WithoutCreateOnce_IsRejected()
    {
        // The staged request must pin single-shot creation. Without it a staged
        // form could become a repeated new-game driver, so it must never arm.
        StagedForm(createOnce: false).IsValid.Should().BeFalse();
    }

    [Fact]
    public void StagedForm_WhenDisabled_IsRejected()
    {
        StagedForm(enable: false).IsValid.Should().BeFalse();
    }

    [Theory]
    [InlineData("", "GameBuddy", "Coffee")]           // empty farm name
    [InlineData("GameBuddy@Farm", "GameBuddy", "Coffee")] // farm-name alphabet
    // The farm name is the only creation field that reaches the world identity: the
    // observed slot basename is its letters and digits plus the game's unique id, and
    // that slot is signed inside the join manifest, which the Host re-serializes with
    // its own JSON encoder. A non-ASCII character would be escaped on one side and
    // written literally on the other, so the HMAC could never match and the whole
    // manifest would be rejected as invalid: reject it here instead.
    [InlineData("Königshof", "GameBuddy", "Coffee")]      // non-ASCII farm name
    [InlineData("GameBuddy Farm", "", "Coffee")]      // empty player name
    [InlineData("GameBuddy Farm", "Game Buddy", "Coffee")] // player-name alphabet
    [InlineData("GameBuddy Farm", "GameBuddy", "")]   // empty favorite thing
    [InlineData("GameBuddy Farm", "GameBuddy", "Coffee_Cake")] // favorite-thing alphabet
    public void StagedForm_WithInvalidIdentity_IsRejected(string farmName, string playerName, string favoriteThing)
    {
        Identity(farmName, playerName, favoriteThing).IsValid.Should().BeFalse();
    }

    [Fact]
    public void StagedForm_WithOversizedIdentity_IsRejectedButTheDocumentedMaximaAreAccepted()
    {
        Identity(new string('A', 33), "GameBuddy", "Coffee").IsValid.Should().BeFalse();
        Identity("GameBuddy Farm", new string('A', 65), "Coffee").IsValid.Should().BeFalse();
        Identity("GameBuddy Farm", "GameBuddy", new string('A', 33)).IsValid.Should().BeFalse();

        Identity(new string('A', 32), new string('A', 64), new string('A', 32)).IsValid.Should().BeTrue();
    }

    // ---- (b) creation happens at most once ------------------------------------------

    [Fact]
    public void TryCreate_WithoutALiveTitleMenu_RequestsNothing()
    {
        // Unverified here: that a live title menu drives the native entry. What is
        // verified is that with no world loaded and no title menu presented the
        // Mod neither asks for a creation nor reports one.
        WithNoLoadedWorld(() =>
        {
            WorldCreationBootstrap bootstrap = CreateBootstrap();

            bootstrap.TryCreate();

            ReadPrivateField<bool>(bootstrap, "creationRequested").Should().BeFalse();
            bootstrap.ObservedSaveSlot.Should().BeEmpty();
            bootstrap.IsArmed.Should().BeTrue();
        });
    }

    [Fact]
    public void TryCreate_WhileTheWorldThisRequestIsCreatingIsLoading_DoesNotFailClosedOrRequestASecondCreation()
    {
        // createdNewCharacter() switches the game into native loading before SMAPI
        // raises SaveLoaded, so `hasLoadedGame` is already true while the one
        // request is still in flight. The request flag is recorded before that
        // native call precisely so this expected intermediate state can never be
        // mistaken for a second attempt (and never fail the process closed).
        WithNoLoadedWorld(() =>
        {
            WorldCreationBootstrap bootstrap = CreateBootstrap();
            SetPrivateField(bootstrap, "creationRequested", true);

            Game1.hasLoadedGame = true;

            bootstrap.TryCreate();

            ReadPrivateField<bool>(bootstrap, "terminal").Should().BeFalse();
            bootstrap.ObservedSaveSlot.Should().BeEmpty();
            bootstrap.IsArmed.Should().BeTrue();
        });
    }

    // ---- (c) a world this request did not produce is never reported as created ------

    [Fact]
    public void TryCreate_WhenAWorldWasAlreadyLoadedWithoutARequestFromThisProcess_FailsClosed()
    {
        WithNoLoadedWorld(() =>
        {
            WorldCreationBootstrap bootstrap = CreateBootstrap();

            Game1.hasLoadedGame = true;

            bootstrap.TryCreate();

            ReadPrivateField<bool>(bootstrap, "creationRequested").Should().BeFalse();
            ReadPrivateField<bool>(bootstrap, "terminal").Should().BeTrue();
            bootstrap.IsArmed.Should().BeFalse();
            bootstrap.ObservedSaveSlot.Should().BeEmpty();
        });
    }

    [Fact]
    public void TryComplete_WithoutARequestFromThisProcess_NeverReportsACreatedWorld()
    {
        // The SaveLoaded side of the same rule: a world that this process did not
        // create in response to a staged request is refused and never observed.
        WorldCreationBootstrap bootstrap = CreateBootstrap();

        bootstrap.TryComplete().Should().BeFalse();
        bootstrap.TryComplete().Should().BeFalse();

        bootstrap.ObservedSaveSlot.Should().BeEmpty();
        ReadPrivateField<bool>(bootstrap, "terminal").Should().BeFalse();
        bootstrap.IsArmed.Should().BeTrue();
    }

    // ---- (d) observed-slot shape ----------------------------------------------------

    [Theory]
    [InlineData("GameBuddy Farm")]
    [InlineData("Farm 1-2!")]
    [InlineData("Königshof")]
    [InlineData("農場")]
    [InlineData("''..''")]
    public void ObservedSlotFilter_IsTheSameFilterTheGameUsesForSaveFolders(string logicalName)
    {
        // WorldCreationBootstrap keeps its own copy of the native filter; the join
        // manifest composes the slot from SaveGame.FilterFileName (SaveGame.cs:448
        // is the game's own save-folder naming). They must stay byte-identical.
        typeof(WorldCreationBootstrap)
            .GetMethod("FilterSaveName", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object[] { logicalName })
            .Should().Be(SaveGame.FilterFileName(logicalName));
    }

    [Fact]
    public void ObservedSaveSlot_IsTheLogicalSaveIdentityPlusTheGameUniqueId()
    {
        foreach (string logicalName in new[] { "GameBuddy Farm", "Farm 1-2!", "Königshof" })
        {
            string slot = HostFarmhandProvisioner.ComposeObservedSaveSlot(logicalName, 445094166UL);

            slot.Should().Be($"{SaveGame.FilterFileName(logicalName)}_445094166");
            slot.Should().MatchRegex("^[\\p{L}\\p{N}]{1,64}_[0-9]{1,32}$");
            foreach (string forbidden in new[] { "/", "\\", ":", " ", ".", "\0" })
                slot.Should().NotContain(forbidden);
        }

        HostFarmhandProvisioner.ComposeObservedSaveSlot("GameBuddy Farm", 0UL)
            .Should().Be("GameBuddyFarm_0");
    }

    [Fact]
    public void SignedManifestBytes_PublishTheObservedSaveSlotNextToTheWorldIdentity()
    {
        // The Host verifies a manifest by re-serializing the object it parsed with
        // JSON.stringify and recomputing the HMAC, so the slot's presence AND its
        // position in the canonical payload are part of the wire contract: a key
        // moved after the signature was defined would silently stop verifying.
        var manifest = new FarmhandJoinManifest
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            RequestId = "request_01",
            IntegrationId = FarmhandProvisioningProtocol.IntegrationId,
            IntegrationVersion = "0.1.0",
            GameVersion = "1.6.15",
            GameBuildNumber = 24356,
            SmapiVersion = "4.5.2",
            MultiplayerProtocol = "1.6.15",
            Endpoint = "127.0.0.1:24642",
            SaveId = "445094166",
            WorldId = "987654321",
            ObservedSaveSlot = "GameBuddyFarm_445094166",
            CompanionId = "companion_01",
            FarmhandId = "123456789",
            CabinId = "cabin_01",
            SessionNonce = "nonce_01",
            IssuedAtUnixMs = 2_000,
            ExpiresAtUnixMs = 19_000,
        };

        // Exactly the payload FarmhandProvisioningProtocol.Sign hashes.
        JsonObject node = (JsonObject)JsonSerializer.SerializeToNode(manifest, FarmhandProvisioningProtocol.JsonOptions)!;
        node.Remove("signature");
        string unsigned = node.ToJsonString(FarmhandProvisioningProtocol.JsonOptions);

        unsigned.Should().Contain(
            "\"worldId\":\"987654321\",\"observedSaveSlot\":\"GameBuddyFarm_445094166\",\"companionId\":\"companion_01\"");

        string signature = FarmhandProvisioningProtocol.Sign(manifest, Token);
        FarmhandProvisioningProtocol
            .HasValidSignature(manifest with { Signature = signature }, signature, Token)
            .Should().BeTrue();
    }

    // ---- native-state helpers -------------------------------------------------------

    /// <summary>
    /// Run <paramref name="body"/> with the two native "a world is already here"
    /// markers cleared, then restore them exactly. Nobody else in the suite depends
    /// on either staying set, but the suite serializes its tests and does mutate
    /// other Game1 statics, so this test never leaves shared state changed.
    /// </summary>
    private static void WithNoLoadedWorld(Action body)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? previousMenu = menuField.GetValue(null);
        bool previousLoaded = Game1.hasLoadedGame;
        try
        {
            menuField.SetValue(null, null);
            Game1.hasLoadedGame = false;
            body();
        }
        finally
        {
            menuField.SetValue(null, previousMenu);
            Game1.hasLoadedGame = previousLoaded;
        }
    }

    private static T ReadPrivateField<T>(WorldCreationBootstrap bootstrap, string name) =>
        (T)typeof(WorldCreationBootstrap).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(bootstrap)!;

    private static void SetPrivateField(WorldCreationBootstrap bootstrap, string name, object value) =>
        typeof(WorldCreationBootstrap).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(bootstrap, value);
}
