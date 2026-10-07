using System.Text;
using System.Text.RegularExpressions;

namespace GameBuddy.Desktop;

/// <summary>
/// The bounded, redacted excerpt of what a launched child wrote to its own stderr.
/// The child's stderr is the operator's only diagnostic when the child refuses the
/// private bootstrap before the launcher ever sees an acknowledgement, so a refusal
/// that names nothing is a launch that cannot be diagnosed at all.
///
/// The bytes come from another process and may carry provider-side text, so nothing
/// leaves here verbatim: the excerpt is one line, it is capped, and every
/// credential-shaped run is replaced. Over-redaction is the intended direction - a
/// partly redacted diagnosis still names the refusal, whereas one leaked secret
/// cannot be taken back.
/// </summary>
internal static class ChildStderrExcerpt
{
    /// <summary>The label the launch failure appends, so the excerpt is attributable.</summary>
    internal const string Label = "host_child_stderr:";

    /// <summary>What the label says when the capture ran and found no bytes at all.</summary>
    internal const string NothingCaptured = "host_child_stderr: (captured nothing)";

    // The excerpt is presentation, not transport: one line of an operator channel.
    private const int MaximumExcerptCharacters = 512;
    private const string Redacted = "<redacted>";

    // A `name=value` / `name: value` pair whose NAME says the value is a credential.
    // The separator is required so ordinary prose that merely contains the word
    // "token" is left readable.
    private static readonly Regex CredentialPair = new(
        @"(?<name>[A-Za-z0-9_.\-]*(?:api[-_]?key|access[-_]?key|client[-_]?secret|secret|token|password|passwd|pwd|authorization|credential|nonce|signature)[A-Za-z0-9_.\-]*)\s*[=:]\s*(?<value>""[^""]*""|'[^']*'|[^\s,;&]+)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex BearerToken = new(
        @"\bBearer\s+[A-Za-z0-9._~+/\-]{8,}=*",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex JsonWebToken = new(
        @"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        RegexOptions.CultureInvariant);
    // Any long run of token characters, kept only when it actually looks generated.
    private static readonly Regex LongToken = new(
        @"[A-Za-z0-9+/=_\-]{32,}",
        RegexOptions.CultureInvariant);

    /// <summary>
    /// The excerpt of the retained child stderr bytes: decoded leniently, reduced to
    /// one line, redacted, and capped. An empty result means the capture retained no
    /// bytes at all - it never means the child said nothing.
    /// </summary>
    internal static string Render(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length == 0) return string.Empty;
        return Cap(OneLine(Redact(Encoding.UTF8.GetString(bytes))));
    }

    /// <summary>
    /// The line the launch failure appends. An empty excerpt is stated as a capture
    /// that found nothing rather than as a child that said nothing, because those are
    /// different facts and only one of them is known.
    /// </summary>
    internal static string Format(string excerpt) =>
        excerpt.Length == 0 ? NothingCaptured : $"{Label} {excerpt}";

    private static string Redact(string text)
    {
        // Order matters: the scheme and the labelled pair are removed before the
        // labelled pair can consume only the scheme word and leave the value behind.
        var redacted = BearerToken.Replace(text, "Bearer " + Redacted);
        redacted = JsonWebToken.Replace(redacted, Redacted);
        redacted = CredentialPair.Replace(redacted, static match => match.Groups["name"].Value + "=" + Redacted);
        return LongToken.Replace(redacted, static match => LooksGenerated(match.Value) ? Redacted : match.Value);
    }

    /// <summary>
    /// Whether a long token-character run looks generated rather than written: pure
    /// hexadecimal, carrying base64 markers, mixing case and digits, or a hyphenated
    /// lowercase-with-digits key shape. A lowercase word, a schema name, a file name or
    /// a hyphenated slug without digits survives.
    /// </summary>
    private static bool LooksGenerated(string value)
    {
        var hasUpper = false;
        var hasLower = false;
        var hasDigit = false;
        var hasBase64Marker = false;
        var hasHyphen = false;
        var allHex = true;
        foreach (var character in value)
        {
            if (character is >= 'A' and <= 'Z') hasUpper = true;
            if (character is >= 'a' and <= 'z') hasLower = true;
            if (character is >= '0' and <= '9') hasDigit = true;
            if (character is '+' or '/' or '=') hasBase64Marker = true;
            if (character == '-') hasHyphen = true;
            if (character is not (>= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F')) allHex = false;
        }
        return allHex || hasBase64Marker || (hasUpper && hasLower && hasDigit) || (hasHyphen && hasLower && hasDigit);
    }

    private static string OneLine(string text)
    {
        var builder = new StringBuilder(text.Length);
        var pendingSpace = false;
        foreach (var character in text)
        {
            if (char.IsWhiteSpace(character) || char.IsControl(character))
            {
                pendingSpace = builder.Length > 0;
                continue;
            }
            if (pendingSpace)
            {
                builder.Append(' ');
                pendingSpace = false;
            }
            builder.Append(character);
        }
        return builder.ToString();
    }

    private static string Cap(string text) =>
        text.Length <= MaximumExcerptCharacters ? text : text[..MaximumExcerptCharacters] + "...";
}
