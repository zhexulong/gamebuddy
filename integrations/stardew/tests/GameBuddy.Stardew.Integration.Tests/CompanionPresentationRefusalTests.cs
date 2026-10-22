using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The companion presentation gate names one refusal per cause. It used to answer
/// `invalid_or_stale_companion_presentation` for six unrelated conditions, so a live run that lost its
/// closing line could not say which one it hit.
/// </summary>
public sealed class CompanionPresentationRefusalTests
{
    [Fact]
    public void CompanionPresentation_NamesEachRefusalAndIsNotRevisionGated()
    {
        CompanionPresentationPolicyTests.Run();
    }
}
