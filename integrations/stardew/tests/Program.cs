using System.Reflection;
using System.Reflection.Metadata;
using System.Runtime.CompilerServices;
using System.Reflection.PortableExecutable;
using GameBuddy.Stardew;

internal static class Program
{
    private const string AssemblyPathEnvironmentVariable = "GAMEBUDDY_STARDEW_ASSEMBLY";

    private static int Main(string[] arguments)
    {
        if (arguments.Length != 3 || arguments[0] != "--expected-sha256")
        {
            Console.Error.WriteLine("Usage: PortfolioMineElevatorProjection.Contract --expected-sha256 <64-lowercase-hex> <path-to-GameBuddy.Stardew.dll>");
            return 2;
        }
        string expectedSha256 = arguments[1];
        string fullProductionAssemblyPath = Path.GetFullPath(arguments[2]);
        if (!File.Exists(fullProductionAssemblyPath)) { Console.Error.WriteLine($"Production assembly does not exist: {fullProductionAssemblyPath}"); return 2; }
        try
        {
            Assembly loadedAssembly = ProductionAssemblyBinding.LoadCanonicalAssembly(expectedSha256, fullProductionAssemblyPath, ValidateProductionAssembly);
            AssertTypedReferenceBindsToLoadedAssembly(loadedAssembly);
            ProductionAssemblyBinding.AssertByteAlteredAssemblyRejectedBeforeTypeLoad(expectedSha256, fullProductionAssemblyPath);
            PortfolioMineLadderIntegrationStructuralContract.Run(loadedAssembly);
            PortfolioMineEntryIntegrationStructuralContract.Run(loadedAssembly);
            PortfolioMineElevatorIntegrationStructuralContract.Run(loadedAssembly);
            Environment.SetEnvironmentVariable(AssemblyPathEnvironmentVariable, fullProductionAssemblyPath);
            SelectableCheckpointTruthTable(); UnlockedSelectionTruthTable(); ElevatorAvailabilityTruthTable(); LadderProjectionTruthTable(); BootstrapHandoffTruthTable(); MineEntryTerminalVocabularyTruthTable(); PortfolioMineCoordinatorLifecycleContract.Run(); PortfolioBridgeSessionGenerationContract.Run(); PlayerControlProtocolTests.Run(); LocalPipeBridgeTests.Run(); NativeChatIngressPolicyTests.Run(); CompanionPresentationPolicyTests.Run(); NativeChatPresentationPolicyTests.Run();
            Console.WriteLine("Portfolio mine projection; Elevator, Entry, and Ladder compiled integration; coordinator lifecycle; bridge-session generation; entry terminal vocabulary; bootstrap handoff; player-control protocol; and native chat ingress policy tests passed."); return 0;
        }
        catch (Exception exception) { Console.Error.WriteLine(exception.Message); return 1; }
    }
    private static void SelectableCheckpointTruthTable()
    {
        Assert(!PortfolioMineElevatorProjection.IsSelectableCheckpoint(4), "checkpoint below lower bound must reject.");
        Assert(PortfolioMineElevatorProjection.IsSelectableCheckpoint(5), "lower bound must select.");
        Assert(!PortfolioMineElevatorProjection.IsSelectableCheckpoint(6), "non-multiple must reject.");
        Assert(PortfolioMineElevatorProjection.IsSelectableCheckpoint(120), "upper bound must select.");
        Assert(!PortfolioMineElevatorProjection.IsSelectableCheckpoint(121), "above upper bound must reject.");
    }

    private static void UnlockedSelectionTruthTable()
    {
        Assert(!PortfolioMineElevatorProjection.IsUnlockedSelection(4, 5), "locked checkpoint must reject.");
        Assert(PortfolioMineElevatorProjection.IsUnlockedSelection(5, 5), "equal progress must unlock.");
        Assert(PortfolioMineElevatorProjection.IsUnlockedSelection(125, 120), "bounded checkpoint must unlock.");
        Assert(!PortfolioMineElevatorProjection.IsUnlockedSelection(125, 125), "progress must not widen domain.");
    }

    private static void ElevatorAvailabilityTruthTable()
    {
        for (int predicates = 0; predicates < 16; predicates++)
        {
            bool actual = PortfolioMineElevatorProjection.IsAccessibleElevatorInteraction((predicates & 1) != 0, (predicates & 2) != 0, (predicates & 4) != 0 ? 120 : 121, (predicates & 8) != 0 ? 112 : 111);
            Assert(actual == (predicates == 15), $"availability truth-table row {predicates} must match.");
        }
    }

    private static void LadderProjectionTruthTable()
    {
        Assert(PortfolioMineLadderProjection.IsLadderTarget(0, 1), "first descent must be valid.");
        Assert(!PortfolioMineLadderProjection.IsLadderTarget(0, 121), "out-of-domain ladder must reject.");
        Assert(PortfolioMineLadderProjection.IsAccessibleLadderInteraction(true, true, 1, 173), "case 173 must allow ladder.");
    }

    private static void BootstrapHandoffTruthTable()
    {
        var activeExecutionHandoff = new PortfolioBootstrapHandoff();
        Assert(activeExecutionHandoff.TryRecordBootstrap(7), "active-execution bootstrap must record.");
        Assert(!activeExecutionHandoff.TryConsumeDisconnect(7, true, out string activeExecutionReason), "active execution must reject bootstrap disconnect handoff.");
        Assert(activeExecutionReason == "portfolio_bootstrap_not_allowed", "active execution rejection must use the bootstrap-not-allowed reason.");
        Assert(!activeExecutionHandoff.HasExpectedStrictGeneration, "active execution rejection must not arm a strict successor.");
        Assert(!activeExecutionHandoff.TryAcceptStrictHello(8), "unarmed strict successor must reject.");
        // Integration owns teardown after this rejection; this pure handoff model does not claim repeat-consume semantics.
        Assert(!activeExecutionHandoff.TryRecordBootstrap(7), "recording the same bootstrap generation again must reject.");

        var happyPathHandoff = new PortfolioBootstrapHandoff();
        Assert(happyPathHandoff.TryRecordBootstrap(7), "first bootstrap must record.");
        Assert(happyPathHandoff.TryConsumeDisconnect(7, false, out _), "disconnect must arm successor.");
        Assert(happyPathHandoff.TryAcceptStrictHello(8), "strict successor must accept.");
    }

    private static void MineEntryTerminalVocabularyTruthTable()
    {
        Assert(PortfolioBridgeProtocol.IsMineEntryTerminalReason("succeeded", "enter_mine_floor_used"), "entry success vocabulary must be accepted.");
        Assert(PortfolioBridgeProtocol.IsMineEntryTerminalReason("uncertain", "native_operation_uncertain"), "uncertain vocabulary must be accepted.");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void AssertTypedReferenceBindsToLoadedAssembly(Assembly loadedAssembly)
    {
        ProductionAssemblyBinding.AssertTypedReferenceBindsToLoadedAssembly(typeof(PortfolioMineElevatorProjection).Assembly, loadedAssembly);
    }

    private static void ValidateProductionAssembly(Stream stream, string productionAssemblyPath)
    {
        using PEReader peReader = new(stream, PEStreamOptions.LeaveOpen);
        if (!peReader.HasMetadata)
            throw new InvalidOperationException($"{AssemblyPathEnvironmentVariable} must name a managed GameBuddy.Stardew assembly: {productionAssemblyPath}");

        MetadataReader reader = peReader.GetMetadataReader();
        string assemblyName = reader.GetString(reader.GetAssemblyDefinition().Name);
        Assert(assemblyName == "GameBuddy.Stardew",
            $"{AssemblyPathEnvironmentVariable} must name GameBuddy.Stardew; found {assemblyName}.");

        TypeDefinition projection = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .SingleOrDefault(type => reader.GetString(type.Namespace) == "GameBuddy.Stardew"
                && reader.GetString(type.Name) == "PortfolioMineElevatorProjection");
        Assert(!projection.Equals(default(TypeDefinition)),
            "Production GameBuddy.Stardew assembly must contain PortfolioMineElevatorProjection.");

        string[] publicMethods = projection.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Where(method => (method.Attributes & System.Reflection.MethodAttributes.Public) != 0)
            .Select(method => reader.GetString(method.Name))
            .ToArray();
        foreach (string requiredMethod in new[] { "IsSelectableCheckpoint", "IsUnlockedSelection", "IsAccessibleElevatorInteraction" })
            Assert(publicMethods.Contains(requiredMethod, StringComparer.Ordinal),
                $"Production PortfolioMineElevatorProjection must expose {requiredMethod}.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
