internal static class FarmhandCapabilityPublicationProjectionProgram
{
    private const string ExpectedModSha256Flag = "--expected-mod-sha256";
    private const string ExpectedCoreSha256Flag = "--expected-core-sha256";

    private static int Main(string[] arguments)
    {
        if (!TryParseArguments(arguments, out string expectedModSha256, out string expectedCoreSha256, out string modPath, out string corePath))
            return 2;

        try
        {
            ValidateDigest(expectedModSha256, ExpectedModSha256Flag);
            ValidateDigest(expectedCoreSha256, ExpectedCoreSha256Flag);
            string fullModPath = ValidateAbsoluteFile(modPath, "Mod");
            string fullCorePath = ValidateAbsoluteFile(corePath, "Core");
            ValidateCoreSibling(fullModPath, fullCorePath);
            FarmhandCapabilityPublicationProjectionTests.Run(expectedModSha256, expectedCoreSha256, fullModPath, fullCorePath);
            Console.Write("Farmhand capability publication identity/path/digest contract passed.");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception.Message);
            return 1;
        }
    }

    private static bool TryParseArguments(
        string[] arguments,
        out string expectedModSha256,
        out string expectedCoreSha256,
        out string modPath,
        out string corePath)
    {
        expectedModSha256 = string.Empty;
        expectedCoreSha256 = string.Empty;
        modPath = string.Empty;
        corePath = string.Empty;

        if (arguments.Length != 6
            || arguments[0] != ExpectedModSha256Flag
            || arguments[2] != ExpectedCoreSha256Flag)
        {
            Console.Error.WriteLine(
                "Usage: FarmhandCapabilityPublicationProjection.Contract --expected-mod-sha256 <64-lowercase-hex> --expected-core-sha256 <64-lowercase-hex> <absolute-Mod-path> <absolute-Core-path>");
            return false;
        }

        expectedModSha256 = arguments[1];
        expectedCoreSha256 = arguments[3];
        modPath = arguments[4];
        corePath = arguments[5];
        return true;
    }

    private static void ValidateDigest(string value, string argumentName)
    {
        if (value.Length != 64 || value.Any(character => character is < '0' or > '9' and < 'a' or > 'f'))
            throw new InvalidOperationException($"{argumentName} must be exactly 64 lowercase hexadecimal characters.");
    }

    private static string ValidateAbsoluteFile(string path, string label)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new InvalidOperationException($"{label} assembly path must be absolute.");
        if (!File.Exists(path))
            throw new InvalidOperationException($"{label} assembly file does not exist: {path}");

        return Path.GetFullPath(path);
    }

    private static void ValidateCoreSibling(string modPath, string corePath)
    {
        string modDirectory = Path.GetDirectoryName(modPath)
            ?? throw new InvalidOperationException("Mod path must have a parent directory.");
        string expectedCorePath = Path.Combine(modDirectory, Path.GetFileName(corePath));
        if (!string.Equals(corePath, Path.GetFullPath(expectedCorePath), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Core assembly must be a sibling in the selected Mod output directory.");
    }
}
