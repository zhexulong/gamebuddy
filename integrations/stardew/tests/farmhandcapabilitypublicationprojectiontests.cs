using System.Security.Cryptography;

internal static class FarmhandCapabilityPublicationProjectionTests
{
    internal static void Run(string expectedModSha256, string expectedCoreSha256, string modPath, string corePath)
    {
        byte[] modBytes = ReadAndAssertDigest(modPath, expectedModSha256, "Mod");
        byte[] coreBytes = ReadAndAssertDigest(corePath, expectedCoreSha256, "Core");
        FarmhandCapabilityPublicationProjectionMetadata.AssertComposition(modBytes, coreBytes);
    }

    private static byte[] ReadAndAssertDigest(string path, string expectedSha256, string label)
    {
        byte[] bytes = File.ReadAllBytes(path);
        byte[] actualSha256 = SHA256.HashData(bytes);
        byte[] expectedDigest = Convert.FromHexString(expectedSha256);
        if (!CryptographicOperations.FixedTimeEquals(expectedDigest, actualSha256))
            throw new InvalidOperationException($"{label} assembly digest does not match its expected SHA-256: {path}");

        return bytes;
    }
}
