using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gates over the declared body hold share one process-wide ledger (<see cref="BodyHold"/>) and one set of Harmony
/// patches, and xUnit runs different test classes in parallel - so they are one collection. Two classes resetting the
/// same ledger would examine each other's state, and the failure would look like a defect in the authority.
/// </summary>
[CollectionDefinition(Name)]
public sealed class BodyHoldLedgerGates
{
    public const string Name = "body-hold";
}
