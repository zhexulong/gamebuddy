using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Sensory;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Direct coverage of the native HUD notice capture/diff seam.
///
/// The observer is a pure reader of <see cref="Game1.hudMessages"/>, so these
/// cases install the exact native list the game itself would hold and pin the
/// two facts the delta depends on: a corner notice (type == null, whatType == 0)
/// is always appended without merging, and a red message (whatType == 3) merges
/// into the existing entry by raising its <c>number</c>.
/// </summary>
public sealed class NativeNoticeObserverTests
{
    [Fact]
    public void Delta_ReportsNoticesAppendedAfterTheSnapshot()
    {
        WithHudMessages(
            new List<HUDMessage> { new("Inventory Full") },
            () =>
            {
                IReadOnlyList<string> before = NativeNoticeObserver.Capture();
                Game1.hudMessages.Add(Corner("Out of season."));

                NativeNoticeObserver.Delta(before).Should().Equal("Out of season.");
            });
    }

    [Fact]
    public void Delta_ReportsAMergedEntryWhoseNumberGrew()
    {
        WithHudMessages(
            new List<HUDMessage> { new("Requires Scythe", 3) { number = 1 } },
            () =>
            {
                IReadOnlyList<string> before = NativeNoticeObserver.Capture();
                // Native merge: addHUDMessage mutates the existing entry in place
                // instead of appending, so only `number` changes.
                Game1.hudMessages[0].number += 1;

                NativeNoticeObserver.Delta(before).Should().Equal("Requires Scythe");
            });
    }

    [Fact]
    public void Delta_DeduplicatesRepeatedNoticeText()
    {
        WithHudMessages(
            new List<HUDMessage>(),
            () =>
            {
                IReadOnlyList<string> before = NativeNoticeObserver.Capture();
                Game1.hudMessages.Add(Corner("Inventory Full"));
                Game1.hudMessages.Add(Corner("Inventory Full"));
                Game1.hudMessages.Add(Corner("Out of season."));

                NativeNoticeObserver.Delta(before).Should().Equal("Inventory Full", "Out of season.");
            });
    }

    [Fact]
    public void Delta_KeepsRepeatedIdenticalNoticesThatAreAlreadyInTheSnapshot()
    {
        // A corner notice does not merge, so two live copies share one identity.
        // Only the occurrence that exceeds the snapshot count is new.
        WithHudMessages(
            new List<HUDMessage>
            {
                Corner("Inventory Full"),
                Corner("Inventory Full"),
            },
            () =>
            {
                IReadOnlyList<string> before = NativeNoticeObserver.Capture();
                Game1.hudMessages.Add(Corner("Inventory Full"));

                NativeNoticeObserver.Delta(before).Should().Equal("Inventory Full");
            });
    }

    [Fact]
    public void Delta_TruncatesAtTheDeclaredNoticeCeiling()
    {
        WithHudMessages(
            new List<HUDMessage>(),
            () =>
            {
                IReadOnlyList<string> before = NativeNoticeObserver.Capture();
                for (int index = 0; index < NativeNoticeObserver.MaximumNotices + 4; index++)
                    Game1.hudMessages.Add(Corner($"notice_{index}"));

                string[] delta = NativeNoticeObserver.Delta(before);

                delta.Should().HaveCount(NativeNoticeObserver.MaximumNotices);
                delta.Should().Equal("notice_0", "notice_1", "notice_2", "notice_3", "notice_4", "notice_5", "notice_6", "notice_7");
            });
    }

    [Fact]
    public void Delta_IgnoresFadeProgressAndReturnsNothingWhenUnchanged()
    {
        WithHudMessages(
            new List<HUDMessage> { new("Out of season.", 5250f) },
            () =>
            {
                IReadOnlyList<string> before = NativeNoticeObserver.Capture();
                // Every notice ages: timeLeft falls and transparency fades. Neither
                // is part of the identity, so aging is never a new notice.
                Game1.hudMessages[0].timeLeft = 12f;
                Game1.hudMessages[0].transparency = 0.4f;

                NativeNoticeObserver.Delta(before).Should().BeEmpty();
            });
    }

    [Fact]
    public void Capture_ReturnsOnlyTheNativeMessageText()
    {
        WithHudMessages(
            new List<HUDMessage> { new("Out of season.", 3) { number = 7 } },
            () =>
            {
                string[] delta = NativeNoticeObserver.Delta(new List<string>());

                // The identity is internal; the delta carries only the raw native text.
                delta.Should().Equal("Out of season.");
            });
    }


    /// <summary>
    /// The shape a native corner notice has (no icon, the 5250ms corner lifetime,
    /// <c>whatType == 0</c> and <c>type == null</c> so <c>addHUDMessage</c> never
    /// merges it), built without <c>HUDMessage.ForCornerTextbox</c>: that factory
    /// runs the text through <c>Game1.parseText</c>, which needs the player and the
    /// dialogue font, so it cannot run headless. The observer reads identity, not
    /// layout, so the wrapped vs unwrapped text is not observable to it.
    /// </summary>
    private static HUDMessage Corner(string message) =>
        new(message) { noIcon = true, timeLeft = 5250f };

    private static void WithHudMessages(List<HUDMessage> messages, System.Action assertion)
    {
        List<HUDMessage>? previous = Game1.hudMessages;
        Game1.hudMessages = messages;
        try
        {
            assertion();
        }
        finally
        {
            Game1.hudMessages = previous;
        }
    }
}
