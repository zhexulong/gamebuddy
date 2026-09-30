using System;
using System.Collections.Generic;
using System.Globalization;
using StardewValley;

namespace GameBuddy.Stardew.Sensory;

/// <summary>
/// Synchronous, game-thread reader of the native HUD notice list.
///
/// Every native notice in the game funnels into the single
/// <see cref="Game1.hudMessages"/> list, so one snapshot/diff pair is enough to
/// tell an action's synchronous window what the game itself reported when it
/// refused or explained something (for example a planted seed answered with
/// "Out of season."). This is a pure reader: it never polls a tick, holds no
/// state between calls, and neither interprets nor translates the native text.
/// </summary>
internal static class NativeNoticeObserver
{
    /// <summary>Bounded notice count carried on one receipt.</summary>
    internal const int MaximumNotices = 8;

    /// <summary>
    /// Transport bound on one notice text, shared with the Host validator. A
    /// native message longer than this keeps its verbatim prefix; the excess is
    /// dropped at the wire boundary rather than failing the receipt that
    /// carries the action's terminal result.
    /// </summary>
    internal const int MaximumNoticeChars = 512;

    /// <summary>
    /// Separator that keeps the composite identity unambiguous for arbitrary
    /// notice text. The message is the trailing segment, so text containing the
    /// separator still parses correctly.
    /// </summary>
    private const char IdentitySeparator = '\u001f';

    /// <summary>
    /// Composite identity of every entry currently in
    /// <see cref="Game1.hudMessages"/>: (message, whatType, number). The same
    /// notice is the same notice while it fades, so <c>timeLeft</c> and
    /// <c>transparency</c> are deliberately excluded.
    /// </summary>
    internal static IReadOnlyList<string> Capture()
    {
        List<HUDMessage>? messages = Game1.hudMessages;
        if (messages is null || messages.Count == 0)
            return Array.Empty<string>();

        var identities = new List<string>(messages.Count);
        foreach (HUDMessage? message in messages)
        {
            if (message?.message is null || message.message.Length == 0)
                continue;
            identities.Add(Identity(message.message, message.whatType, message.number));
        }

        return identities;
    }

    /// <summary>
    /// Native notice texts that appeared, or whose merge count grew, between
    /// <paramref name="before"/> and now. Native merging mutates an existing
    /// entry's <c>number</c> in place, so a merge surfaces as a new
    /// (message, whatType, number) identity; diffing identities therefore
    /// reports a fresh notice and a merged one through the same path. Repeated
    /// texts collapse to one entry, the original order is kept, and the result
    /// is bounded by <see cref="MaximumNotices"/>.
    /// </summary>
    internal static string[] Delta(IReadOnlyList<string> before)
    {
        IReadOnlyList<string> current = Capture();
        if (current.Count == 0)
            return Array.Empty<string>();

        // Identities are counted, not merely present: an identical corner notice
        // appended while an earlier copy is still alive repeats the same
        // identity, and only the surplus occurrence is new.
        var remaining = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (string identity in before)
            remaining[identity] = remaining.TryGetValue(identity, out int count) ? count + 1 : 1;

        var notices = new List<string>(MaximumNotices);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string identity in current)
        {
            if (remaining.TryGetValue(identity, out int available) && available > 0)
            {
                remaining[identity] = available - 1;
                continue;
            }

            string message = Message(identity);
            if (message.Length == 0 || !seen.Add(message))
                continue;
            notices.Add(Bound(message));
            if (notices.Count == MaximumNotices)
                break;
        }

        return notices.ToArray();
    }

    private static string Identity(string message, int whatType, int number) =>
        whatType.ToString(CultureInfo.InvariantCulture)
        + IdentitySeparator
        + number.ToString(CultureInfo.InvariantCulture)
        + IdentitySeparator
        + message;

    private static string Message(string identity)
    {
        int first = identity.IndexOf(IdentitySeparator, StringComparison.Ordinal);
        int second = first < 0 ? -1 : identity.IndexOf(IdentitySeparator, first + 1);
        return second < 0 ? string.Empty : identity[(second + 1)..];
    }

    private static string Bound(string message) =>
        message.Length <= MaximumNoticeChars ? message : message[..MaximumNoticeChars];
}
