using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

internal static class ProductionAssemblyBinding
{
    private const string ProductionAssemblyName = "GameBuddy.Stardew";
    private static readonly Regex LowercaseSha256 = new("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);

    internal static Assembly LoadCanonicalAssembly(
        string expectedSha256,
        string canonicalAssemblyPath,
        Action<Stream, string> validateMetadata)
    {
        if (string.IsNullOrWhiteSpace(canonicalAssemblyPath))
            throw new ArgumentException("A canonical GameBuddy.Stardew assembly path is required.", nameof(canonicalAssemblyPath));
        ArgumentNullException.ThrowIfNull(validateMetadata);
        byte[] expectedHash = ParseExpectedSha256(expectedSha256);

        AssertNotAlreadyLoaded();

        // Capture the caller-selected image once. Every later operation uses an
        // independent stream over this private snapshot, never the filesystem path.
        byte[] canonicalSnapshot = ReadSnapshot(canonicalAssemblyPath);
        VerifyExpectedSha256(canonicalSnapshot, expectedHash);
        AssemblyName expectedIdentity;
        using (MemoryStream identityStream = new(canonicalSnapshot, writable: false))
            expectedIdentity = ReadAssemblyIdentity(identityStream);
        using (MemoryStream metadataStream = new(canonicalSnapshot, writable: false))
            validateMetadata(metadataStream, canonicalAssemblyPath);

        Assembly loadedAssembly;
        using (MemoryStream loadStream = new(canonicalSnapshot, writable: false))
            loadedAssembly = AssemblyLoadContext.Default.LoadFromStream(loadStream);
        AssertExpectedDefaultAssembly(loadedAssembly, expectedIdentity);
        return loadedAssembly;
    }

    internal static void AssertTypedReferenceBindsToLoadedAssembly(Assembly typedReferenceAssembly, Assembly loadedAssembly)
    {
        ArgumentNullException.ThrowIfNull(typedReferenceAssembly);
        ArgumentNullException.ThrowIfNull(loadedAssembly);

        if (!ReferenceEquals(typedReferenceAssembly, loadedAssembly))
        {
            throw new InvalidOperationException(
                "The typed GameBuddy.Stardew reference did not bind to the canonical assembly loaded into AssemblyLoadContext.Default.");
        }
    }

    internal static void AssertByteAlteredAssemblyRejectedBeforeTypeLoad(string expectedSha256, string canonicalAssemblyPath)
    {
        byte[] expectedHash = ParseExpectedSha256(expectedSha256);
        string alteredAssemblyPath = Path.Combine(Path.GetTempPath(), $"gamebuddy-stardew-byte-altered-{Guid.NewGuid():N}.dll");
        try
        {
            byte[] canonicalSnapshot = ReadSnapshot(canonicalAssemblyPath);
            File.WriteAllBytes(alteredAssemblyPath, canonicalSnapshot.Concat(new byte[] { 0 }).ToArray());
            byte[] alteredSnapshot = ReadSnapshot(alteredAssemblyPath);
            try
            {
                VerifyExpectedSha256(alteredSnapshot, expectedHash);
            }
            catch (InvalidOperationException)
            {
                return;
            }

            throw new InvalidOperationException("The byte-altered assembly was accepted by the expected SHA-256 binding.");
        }
        finally
        {
            File.Delete(alteredAssemblyPath);
        }
    }

    private static byte[] ParseExpectedSha256(string expectedSha256)
    {
        if (expectedSha256 is null || !LowercaseSha256.IsMatch(expectedSha256))
            throw new ArgumentException("Expected SHA-256 must be exactly 64 lowercase hexadecimal characters.", nameof(expectedSha256));
        return Convert.FromHexString(expectedSha256);
    }

    private static byte[] ReadSnapshot(string canonicalAssemblyPath)
    {
        using FileStream stream = new(canonicalAssemblyPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using MemoryStream snapshot = new();
        stream.CopyTo(snapshot);
        return snapshot.ToArray();
    }

    private static void VerifyExpectedSha256(byte[] snapshot, byte[] expectedHash)
    {
        byte[] actualHash = SHA256.HashData(snapshot);
        if (!CryptographicOperations.FixedTimeEquals(expectedHash, actualHash))
            throw new InvalidOperationException("The canonical GameBuddy.Stardew assembly does not match the supplied expected SHA-256.");
    }

    private static AssemblyName ReadAssemblyIdentity(Stream stream)
    {
        using PEReader peReader = new(stream, PEStreamOptions.LeaveOpen);
        if (!peReader.HasMetadata)
            throw new InvalidOperationException("The canonical GameBuddy.Stardew assembly must be a managed PE.");

        MetadataReader reader = peReader.GetMetadataReader();
        AssemblyDefinition definition = reader.GetAssemblyDefinition();
        AssemblyName identity = new(reader.GetString(definition.Name))
        {
            Version = definition.Version,
            CultureName = definition.Culture.IsNil ? null : reader.GetString(definition.Culture),
        };
        if (!definition.PublicKey.IsNil)
            identity.SetPublicKey(reader.GetBlobBytes(definition.PublicKey));
        return identity;
    }

    private static string NormalizeCulture(string? culture)
    {
        return string.IsNullOrEmpty(culture) || string.Equals(culture, "neutral", StringComparison.OrdinalIgnoreCase)
            ? "neutral"
            : culture;
    }

    private static void AssertNotAlreadyLoaded()
    {
        if (AssemblyLoadContext.Default.Assemblies.Any(assembly => assembly.GetName().Name == ProductionAssemblyName))
        {
            throw new InvalidOperationException(
                "GameBuddy.Stardew was already loaded in AssemblyLoadContext.Default before canonical binding.");
        }
    }

    private static void AssertExpectedDefaultAssembly(Assembly assembly, AssemblyName expectedIdentity)
    {
        AssemblyName actualIdentity = assembly.GetName();
        if (actualIdentity.Name != ProductionAssemblyName)
            throw new InvalidOperationException($"The canonical assembly must be named {ProductionAssemblyName}; found {actualIdentity.Name}.");

        if (!Equals(actualIdentity.Version, expectedIdentity.Version)
            || !string.Equals(NormalizeCulture(actualIdentity.CultureName), NormalizeCulture(expectedIdentity.CultureName), StringComparison.OrdinalIgnoreCase)
            || !(actualIdentity.GetPublicKeyToken() ?? Array.Empty<byte>()).SequenceEqual(expectedIdentity.GetPublicKeyToken() ?? Array.Empty<byte>()))
        {
            throw new InvalidOperationException(
                $"The loaded GameBuddy.Stardew identity ({actualIdentity.FullName}) does not match the canonical image identity ({expectedIdentity.FullName}).");
        }

        if (!ReferenceEquals(AssemblyLoadContext.GetLoadContext(assembly), AssemblyLoadContext.Default))
            throw new InvalidOperationException("GameBuddy.Stardew must be loaded into AssemblyLoadContext.Default.");
    }
}
