using System.Reflection;
using System.Reflection.Metadata;
using System.Runtime.CompilerServices;
using System.Reflection.PortableExecutable;

internal static class FarmhandActionCapabilityProjectionProgram
{
    private const string AssemblyPathEnvironmentVariable = "GAMEBUDDY_STARDEW_ASSEMBLY";

    private static int Main(string[] arguments)
    {
        bool writeManifest;
        string expectedSha256;
        string productionAssemblyPath;
        string? manifestPath = null;
        if (arguments.Length == 3 && arguments[0] == "--expected-sha256")
        {
            writeManifest = false;
            expectedSha256 = arguments[1];
            productionAssemblyPath = arguments[2];
        }
        else if (arguments.Length == 4 && arguments[0] == "--write-default-enabled-actions")
        {
            writeManifest = true;
            expectedSha256 = arguments[1];
            productionAssemblyPath = arguments[2];
            manifestPath = arguments[3];
        }
        else
        {
            Console.Error.WriteLine("Usage: FarmhandActionCapabilityProjection.Contract --expected-sha256 <64-lowercase-hex> <path-to-GameBuddy.Stardew.dll>");
            Console.Error.WriteLine("   or: FarmhandActionCapabilityProjection.Contract --write-default-enabled-actions <64-lowercase-hex> <path-to-GameBuddy.Stardew.dll> <new-manifest-path>");
            return 2;
        }

        string fullProductionAssemblyPath = Path.GetFullPath(productionAssemblyPath);
        if (!File.Exists(fullProductionAssemblyPath)) { Console.Error.WriteLine($"Production assembly does not exist: {fullProductionAssemblyPath}"); return 2; }
        try
        {
            Assembly loadedAssembly = ProductionAssemblyBinding.LoadCanonicalAssembly(expectedSha256, fullProductionAssemblyPath, ValidateProductionAssembly);
            AssertTypedReferenceBindsToLoadedAssembly(loadedAssembly);
            ProductionAssemblyBinding.AssertByteAlteredAssemblyRejectedBeforeTypeLoad(expectedSha256, fullProductionAssemblyPath);
            Environment.SetEnvironmentVariable(AssemblyPathEnvironmentVariable, fullProductionAssemblyPath);

            if (writeManifest)
            {
                FarmhandActionProjectionManifest.WriteDefaultEnabledActions(manifestPath!);
                Console.WriteLine("Farmhand default action projection manifest written.");
                return 0;
            }

            FarmhandActionCapabilityProjectionTests.RunPolicySemantics(); FarmhandActionCapabilityProjectionTests.RunSameLiveSurfaceHelloAndWorldNotReadySnapshotCharacterization(); FarmhandActionCapabilityProjectionTests.RunPortfolioAndFarmhandActionIsolationCharacterization(); FarmhandCapabilityRuntimeStaticTests.Run();
            Console.WriteLine("Farmhand action capability projection tests passed."); return 0;
        }
        catch (Exception exception) { Console.Error.WriteLine(exception.Message); return 1; }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void AssertTypedReferenceBindsToLoadedAssembly(Assembly loadedAssembly)
    {
        ProductionAssemblyBinding.AssertTypedReferenceBindsToLoadedAssembly(typeof(GameBuddy.Stardew.ModConfig).Assembly, loadedAssembly);
    }

    private static void ValidateProductionAssembly(Stream stream, string productionAssemblyPath)
    {
        using PEReader peReader = new(stream, PEStreamOptions.LeaveOpen);
        if (!peReader.HasMetadata)
            throw new InvalidOperationException($"{AssemblyPathEnvironmentVariable} must name a managed GameBuddy.Stardew assembly: {productionAssemblyPath}");

        MetadataReader reader = peReader.GetMetadataReader();
        string assemblyName = reader.GetString(reader.GetAssemblyDefinition().Name);
        Assert(assemblyName == "GameBuddy.Stardew",
            $"{AssemblyPathEnvironmentVariable} must name GameBuddy.Stardew; found {assemblyName}.");

        AssertTypeWithPublicMethod(reader, "ModConfig", "CreateFarmhandCapabilitySurface");
        AssertTypeWithPublicMethod(reader, "ExecutionManager", "CreateBridgeSnapshot");
        AssertType(reader, "FarmhandCapabilitySurface");
        AssertType(reader, "BridgeSession");
        AssertType(reader, "ModEntry");
    }

    private static void AssertTypeWithPublicMethod(MetadataReader reader, string typeName, string methodName)
    {
        TypeDefinition type = AssertType(reader, typeName);
        bool hasMethod = type.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Any(method => reader.GetString(method.Name) == methodName
                && (method.Attributes & MethodAttributes.Public) != 0);
        Assert(hasMethod, $"Production {typeName} must expose public {methodName}.");
    }

    private static TypeDefinition AssertType(MetadataReader reader, string typeName)
    {
        TypeDefinition type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .SingleOrDefault(candidate => reader.GetString(candidate.Namespace) == "GameBuddy.Stardew"
                && reader.GetString(candidate.Name) == typeName);
        Assert(!type.Equals(default(TypeDefinition)),
            $"Production GameBuddy.Stardew assembly must contain {typeName}.");
        return type;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
