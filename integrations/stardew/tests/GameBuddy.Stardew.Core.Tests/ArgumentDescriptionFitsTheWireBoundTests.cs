using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// ONE OVER-LONG SENTENCE REFUSES THE WHOLE ATTACH, so the sentence is refused where it is AUTHORED.
///
/// <para>
/// Measured 2026-11-25: <c>use_mine_ladder</c>'s <c>expectedTargetId</c> sentence was 595 characters, the Host's
/// <c>isValidActionDescriptor</c> bounded an argument description at 512, and one refused descriptor refuses the WHOLE
/// <c>hello_ack</c> registration list (<c>invalid_hello_ack</c>) - so no tool mounted and no session attached. The
/// producer had no bound at all: the artifact gateway stated one, the wire stated another, and the C# that writes BOTH
/// published shapes stated neither.
/// </para>
///
/// <para>
/// The population is the shipped catalog (<see cref="FarmhandActionCatalog.Registrations"/>), never a list here, so the
/// next sentence is measured without anyone editing this file. Two readings: the catalog fits the bound, and the refusal
/// names the action, the argument and both numbers - a refusal that says only "bounds" costs a live run to localise.
/// </para>
/// </summary>
public sealed class ArgumentDescriptionFitsTheWireBoundTests
{
    [Fact]
    public void EveryPublishedArgumentSentenceFitsTheHostsBound()
    {
        (string ActionId, string Argument, int Length) longest = ("none", "none", 0);
        int examined = 0;

        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor is not { } descriptor)
                continue;
            foreach (FarmhandActionArgument argument in descriptor.Arguments)
            {
                if (argument.Description is not { } description)
                    continue;
                examined++;
                if (description.Length > longest.Length)
                    longest = (registration.ActionId, argument.Name, description.Length);
            }
        }

        // Not vacuous: 71 arguments published a sentence on 2026-11-25, and a bound no sentence is measured against
        // passes for the wrong reason.
        examined.Should().BeGreaterThan(60, "the catalog publishes argument sentences; a bound nothing is measured against is not a bound");

        string because = $"every published sentence is at most {FarmhandActionArgument.MaximumDescriptionLength} characters (longest: {longest.Length} on {longest.ActionId}.{longest.Argument})";
        Action validate = () => FarmhandActionCatalog.ValidateArgumentDescriptions(FarmhandActionCatalog.Registrations);
        validate.Should().NotThrow(because);
    }

    [Fact]
    public void ASentenceOneCharacterOverTheBoundIsRefusedNamingTheActionTheArgumentAndBothNumbers()
    {
        string sentence = new('x', FarmhandActionArgument.MaximumDescriptionLength + 1);

        Action refusal = () => FarmhandActionCatalog.ValidateArgumentDescriptions(
            new[] { Registration("probe_action", "expectedTargetId", sentence) });

        refusal.Should()
            .Throw<InvalidOperationException>()
            .WithMessage(
                $"*probe_action*expectedTargetId*{FarmhandActionArgument.MaximumDescriptionLength + 1} characters*"
                + $"over the {FarmhandActionArgument.MaximumDescriptionLength}*invalid_hello_ack*");
    }

    [Fact]
    public void TheBoundIsInclusive()
    {
        string atTheBound = new('x', FarmhandActionArgument.MaximumDescriptionLength);
        string oneOver = new('x', FarmhandActionArgument.MaximumDescriptionLength + 1);

        Action admitted = () => FarmhandActionCatalog.ValidateArgumentDescriptions(
            new[] { Registration("probe_action", "expectedTargetId", atTheBound) });
        Action refused = () => FarmhandActionCatalog.ValidateArgumentDescriptions(
            new[] { Registration("probe_action", "expectedTargetId", oneOver) });

        admitted.Should().NotThrow("the Host admits a sentence of exactly the bound");
        refused.Should().Throw<InvalidOperationException>("one character over is over");
    }

    [Fact]
    public void APresentButEmptySentenceIsRefusedAndAnAbsentOneIsAdmitted()
    {
        Action empty = () => FarmhandActionCatalog.ValidateArgumentDescriptions(
            new[] { Registration("probe_action", "expectedTargetId", "   ") });
        Action absent = () => FarmhandActionCatalog.ValidateArgumentDescriptions(
            new[] { Registration("probe_action", "expectedTargetId", null) });

        empty.Should()
            .Throw<InvalidOperationException>("the Host refuses a present-but-empty description, so publishing one refuses the whole attach")
            .WithMessage("*probe_action*expectedTargetId*empty*");
        absent.Should().NotThrow("an absent description is how an argument says its name is the whole story");
    }

    /// <summary>
    /// The bound is the HOST's, and this asserts it is not quietly widened here: the Mod may not admit a sentence the
    /// Host refuses. 512 is what the frame can carry (the artifact already spends 120,907 of the 131,072-byte frame
    /// budget on 2026-11-25, and 71 sentences at 2,048 would be 145,408 characters), and a larger number here is a
    /// sentence that dies at attach.
    /// </summary>
    [Fact]
    public void TheBoundIsTheHostsFiveHundredAndTwelve()
    {
        FarmhandActionArgument.MaximumDescriptionLength.Should().Be(512);
    }

    private static FarmhandActionRegistration Registration(string actionId, string argumentName, string? description) =>
        new(
            actionId,
            "movement_navigation",
            1,
            FarmhandActionLifecycle.Published,
            FarmhandOperationKind.Execution,
            FarmhandActionHandlerGroup.Movement,
            new FarmhandActionDescriptor(
                new[] { new FarmhandActionArgument(argumentName, "string", Description: description) },
                new Dictionary<string, string>(StringComparer.Ordinal),
                Array.Empty<FarmhandActionResourceTemplateClaim>(),
                "write",
                "native_action_postcondition"));
}
