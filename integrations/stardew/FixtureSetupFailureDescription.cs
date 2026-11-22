using System;

namespace GameBuddy.Stardew;

/// <summary>
/// The one line a fixture-setup failure publishes: what threw, what it said, and the first frame that carries a line
/// number.
///
/// <para>
/// WHY THIS EXISTS. Measured 2026-11-22 22:40:54, the first launch after `386f43a5`:
/// <c>error=unexpected_fixture_setup_exception; exception_type=InvalidOperationException</c> and nothing else - no
/// message, no frame. The launch measured that something was wrong and not what, so the refusal had to be answered by
/// re-reading the fixture instead of the log. The cause was a NAMED refusal introduced by that same commit
/// (<c>fixture_map_cannot_hold_animal_building:footprints=2;best=...</c>) hidden by the filter this type replaced: it
/// published only messages beginning with <c>fixture_native_</c>, so every newer name - and every engine exception -
/// was reduced to the same sentence.
/// </para>
///
/// <para>
/// SO THERE IS NO VOCABULARY HERE. A message that begins with a snake_case token is the fixture's own name for the
/// failure and is published WHOLE, because its reading (<c>footprints=</c>, <c>eliminated=</c>, <c>rejected=</c>,
/// <c>best=</c>) is what the next repair is chosen from - and a prefix list is exactly what hid it. Everything else is
/// published as <c>unexpected_fixture_setup_exception:&lt;type&gt;:&lt;message[:200]&gt;:at=&lt;frame&gt;</c>, so a
/// foreign throw is named too instead of being reduced to "something happened".
/// </para>
/// </summary>
internal static class FixtureSetupFailureDescription
{
    /// <summary>How much of an exception's own prose the log carries: enough to name it, short of a dump.</summary>
    internal const int ForeignMessageLimit = 200;

    /// <summary>The prefix a description carries when the exception does not name the failure itself.</summary>
    internal const string UnnamedPrefix = "unexpected_fixture_setup_exception";

    /// <summary>The line for one fixture-setup exception. Never returns null and never returns an empty string.</summary>
    internal static string Describe(Exception exception)
    {
        string message = exception.Message ?? string.Empty;
        return IsNamedRefusal(message)
            ? message
            : $"{UnnamedPrefix}:{exception.GetType().Name}:{Limit(message)}:at={FirstFrameWithLine(exception)}";
    }

    /// <summary>
    /// True when the message is the fixture's own name for the failure: a snake_case token that is the whole message or
    /// is followed by its reading.
    ///
    /// <para>
    /// THE SHAPE DECIDES, NOT A LIST. Every refusal this fixture throws is written that way (<c>fixture_...</c>,
    /// <c>animal_building_unreachable_from_house</c>, <c>farm_has_no_back_layer</c>), while the engine and the runtime
    /// answer with prose that begins with a capital, a quote or a bracketed id. A list of accepted prefixes is how
    /// <c>fixture_map_cannot_hold_animal_building</c> disappeared: the list was written before the name existed.
    /// </para>
    /// </summary>
    internal static bool IsNamedRefusal(string message)
    {
        if (message.Length < 3 || message[0] < 'a' || message[0] > 'z')
            return false;
        int token = 0;
        while (token < message.Length
            && ((message[token] >= 'a' && message[token] <= 'z')
                || (message[token] >= '0' && message[token] <= '9')
                || message[token] == '_'))
            token += 1;
        // `error: something` is prose that happens to carry a colon; a name is snake_case and therefore holds the
        // separator every code the fixture writes shares.
        if (!message[..token].Contains('_', StringComparison.Ordinal))
            return false;
        return token == message.Length || message[token] == ':';
    }

    /// <summary>The first stack frame that names a source line, or `unavailable` when the build carried no symbols.</summary>
    internal static string FirstFrameWithLine(Exception exception)
    {
        foreach (string line in (exception.StackTrace ?? string.Empty).Split('\n'))
        {
            string frame = line.Trim();
            if (!frame.Contains(":line ", StringComparison.Ordinal))
                continue;
            return frame.StartsWith("at ", StringComparison.Ordinal) ? frame[3..] : frame;
        }
        return "unavailable";
    }

    private static string Limit(string message) =>
        message.Length <= ForeignMessageLimit ? message : message[..ForeignMessageLimit] + "...";
}
