using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// NO MENU THE ENGINE RAISES FOR THE NIGHT MAY LEAVE THE ACTOR STUCK.
///
/// <para>
/// `showEndOfNightStuff` (Game1.cs:9112-9161) makes three pushes onto `Game1.endOfNightMenus`, and the new day cannot
/// begin until that stack has drained (`Game1.cs:4292-4305`). Every one of them therefore holds the crossing, and every
/// one needs a step: a settlement sheet the lifecycle commits, a save screen that runs itself, or - the case this gate
/// exists for - a `LevelUpMenu` that only the companion's own published answer can close.
/// </para>
/// <para>
/// The population is <see cref="SleepAndAdvanceDayLifecycle.OvernightMenus"/>, which is also what
/// <see cref="SleepAndAdvanceDayLifecycle.IsRolloverSettlementMenu"/> and the waits' frame accounting read. Adding the
/// fourth menu the engine may push to that declaration is the one edit that makes this gate see it, and a member that has
/// lost its forward step fails by name (<c>overnight_menu_without_forward_action:&lt;type&gt;</c>) instead of showing up
/// as a night that never crossed.
/// </para>
/// <para>
/// WHY IT IS WORTH A GATE: the same class has shipped twice. 2026-10-17 (run g18) the modal family did not list
/// `respond_level_up`, every dispatch was refused, and the night ended `actor_held_by_unclosable_menu:LevelUpMenu`; the
/// multi-day Given's answer to it was to pin every skill to 10 so the menu could never appear - a run that proves nothing
/// about the night it exists to measure.
/// </para>
/// <para>
/// No menu is constructed here: `LevelUpMenu`'s own constructor reads `Game1.player` and `Game1.content`, and the fact
/// under test is the declaration, which is keyed by the engine's own type.
/// </para>
/// </summary>
public sealed class OvernightMenuForwardActionTests
{
    [Fact]
    public void EveryOvernightMenuHasAForwardStep()
    {
        IReadOnlyList<SleepAndAdvanceDayLifecycle.OvernightMenu> population = SleepAndAdvanceDayLifecycle.OvernightMenus;

        IReadOnlyList<string> violations = SleepAndAdvanceDayLifecycle.OvernightMenuForwardActionViolations(
            population,
            FarmhandActionCatalog.ModalResolvingActionIds);

        violations.Should().BeEmpty(
            $"examined {population.Count} overnight menus ({Names(population)}); each must be answered by a published "
                + "modal-family action or state why it needs none");

        // The three the engine pushes, and no placeholder among them: an entry that survives the property above but names a
        // menu the engine does not raise would be a rule about nothing.
        population.Select(menu => menu.MenuType).Should().BeEquivalentTo(
            new[] { typeof(ShippingMenu), typeof(SaveGameMenu), typeof(LevelUpMenu) });
        population.Should().OnlyHaveUniqueItems(menu => menu.MenuType, "a menu declared twice is two answers to one question");
    }

    [Fact]
    public void TheLevelUpMenuIsAnsweredByAPublishedActionAndNotByTheLifecycle()
    {
        // The member this gate was written for, asserted on its own so a failure says which half broke.
        SleepAndAdvanceDayLifecycle.OvernightMenu? levelUp = SleepAndAdvanceDayLifecycle.OvernightMenuFor(typeof(LevelUpMenu));

        levelUp.Should().NotBeNull("the engine raises it for every pending level (Game1.cs:9130-9134)");
        levelUp!.Forward.Should().Be(SleepAndAdvanceDayLifecycle.OvernightMenuForwardAction.CompanionAnswers);
        levelUp.ActionId.Should().Be("respond_level_up");
        FarmhandActionCatalog.ModalResolvingActionIds.Should().Contain(
            levelUp.ActionId,
            "the answer arrives while the menu holds the actor, so the Modal admission profile has to admit it");
        SleepAndAdvanceDayLifecycle.OvernightMenuFor(typeof(ShippingMenu))!.Forward.Should().Be(
            SleepAndAdvanceDayLifecycle.OvernightMenuForwardAction.LifecycleCommits,
            "and the settlement sheet is still the one menu the lifecycle may close itself");
    }

    [Fact]
    public void AMenuWithNoForwardStepIsNamedRatherThanLeftStanding()
    {
        // INJECTED, and the injection is the run that shipped the defect: 2026-10-17 (g18) had this declaration in effect -
        // the engine raised the menu, and the modal family did not answer it.
        IReadOnlyCollection<string> familyWithoutTheAnswer = FarmhandActionCatalog.ModalResolvingActionIds
            .Where(id => id != "respond_level_up")
            .ToArray();

        SleepAndAdvanceDayLifecycle.OvernightMenuForwardActionViolations(
                SleepAndAdvanceDayLifecycle.OvernightMenus,
                familyWithoutTheAnswer)
            .Should()
            .ContainSingle()
            .Which.Should()
            .StartWith("overnight_menu_without_forward_action:LevelUpMenu");

        // And a member nobody explained fails the same way: "it advances itself" with no stated reason is the other half of
        // the actor having no forward step.
        SleepAndAdvanceDayLifecycle.OvernightMenuForwardActionViolations(
                new[]
                {
                    new SleepAndAdvanceDayLifecycle.OvernightMenu(
                        typeof(SaveGameMenu),
                        SleepAndAdvanceDayLifecycle.OvernightMenuForwardAction.EngineDrives,
                        null,
                        "  "),
                },
                FarmhandActionCatalog.ModalResolvingActionIds)
            .Should()
            .ContainSingle()
            .Which.Should()
            .StartWith("overnight_menu_without_forward_action:SaveGameMenu");
    }

    [Fact]
    public void AnEmptyPopulationIsBlockedInsteadOfAgreeingWithItself()
    {
        SleepAndAdvanceDayLifecycle.OvernightMenuForwardActionViolations(
                Array.Empty<SleepAndAdvanceDayLifecycle.OvernightMenu>(),
                FarmhandActionCatalog.ModalResolvingActionIds)
            .Should()
            .ContainSingle()
            .Which.Should()
            .Be("overnight_menu_population_empty");
    }

    /// <summary>
    /// The night a level-up is raised on, read through the decisions the waits actually make.
    ///
    /// <para>
    /// MEASURED 2026-10-22 (`.live-runs/game-ladder/2026-10-22T06-19-06-618Z-multiday_routine`), in order: `sleep`
    /// accepted, the bed prompt answered, `respond_level_up` -> `level_up_resolved`
    /// (`remaining_new_levels=0;menu_closed=true`), the settlement sheet settled, `day_started`, and the night's own
    /// receipt `day_advanced` with `day_before=4;day_after=5`. That run armed its pending level in the fixture; what this
    /// test adds is the reading of the WAITS on the same frames, which no receipt carries.
    /// </para>
    /// </summary>
    [Fact]
    public void TheNightThatRaisesALevelUpMenuIsHeldByItRatherThanReadAsANightThatDidNotStart()
    {
        bool levelUpStanding = SleepAndAdvanceDayLifecycle.OvernightMenuFor(typeof(LevelUpMenu)) is not null;
        bool questionBoxStanding = SleepAndAdvanceDayLifecycle.OvernightMenuFor(typeof(DialogueBox)) is not null;

        // A question box is NOT one of the night's own menus: it is a modal holding the actor, and the wait for the
        // crossing must keep spending its budget on it or a night that never began reads as one that began and stalled.
        questionBoxStanding.Should().BeFalse("`showEndOfNightStuff` pushes no dialogue box; a box is a hold, not a step");

        // The menu stands while the companion takes a whole turn to answer it - measured turns on this harness run into
        // tens of seconds, which is thousands of frames against a 300-frame save-boundary budget.
        int budget = SleepAndAdvanceDayLifecycle.SaveBoundaryFrameBudget;
        int saveBoundaryFrames = 0;
        for (int frame = 0; frame < budget * 4; frame += 1)
        {
            SleepAndAdvanceDayLifecycle.SaveBoundaryOutcome decision = SleepAndAdvanceDayLifecycle.DecideSaveBoundary(
                saved: false,
                engineCrossingMenuStanding: levelUpStanding,
                saveBoundaryFrames,
                budget);
            decision.Should().Be(
                SleepAndAdvanceDayLifecycle.SaveBoundaryOutcome.EngineMenuHoldsTheFrame,
                "the save cannot begin while the level-up menu is up (Game1.cs:4292-4305), so no frame of it is a save the night missed");
            if (decision == SleepAndAdvanceDayLifecycle.SaveBoundaryOutcome.Waiting)
                saveBoundaryFrames += 1;
        }
        saveBoundaryFrames.Should().Be(0, "a save that could not start is not a save the night failed to take");

        // The day-start wait on the same frames: the counter already moved (+1, the rollover is synchronous) and
        // `DayStarted` cannot arrive until the menu is answered.
        SleepAndAdvanceDayLifecycle.DecideDayStart(
                delta: 1,
                dayStartedObserved: false,
                dayStartWaitFrames: budget * 4,
                budget,
                engineCrossingMenuStanding: levelUpStanding)
            .Should()
            .Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.Waiting);

        // And the half that must not be lost: with nothing of the engine's standing, the same frames DO expire.
        SleepAndAdvanceDayLifecycle.DecideDayStart(
                delta: 1,
                dayStartedObserved: false,
                dayStartWaitFrames: budget * 4,
                budget,
                engineCrossingMenuStanding: questionBoxStanding)
            .Should()
            .Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.NotObserved);
    }

    private static string Names(IReadOnlyList<SleepAndAdvanceDayLifecycle.OvernightMenu> population) =>
        string.Join(",", population.Select(menu => $"{menu.MenuType.Name}:{menu.Forward}"));
}
