internal static class FarmhandHandlerSplitContractProgram
{
    private static int Main(string[] arguments)
    {
        if (arguments.Length < 3 || arguments[0] != "--expected-sha256")
        {
            Console.Error.WriteLine("Usage: FarmhandHandlerSplit.Contract --expected-sha256 <64-lowercase-hex> <path-to-GameBuddy.Stardew.dll> [--source-root <mod-source-dir>]");
            return 2;
        }

        string expectedSha256 = arguments[1];
        string productionAssemblyPath = arguments[2];
        string? sourceRoot = null;
        for (int index = 3; index < arguments.Length; index++)
        {
            if (arguments[index] == "--source-root" && index + 1 < arguments.Length)
            {
                sourceRoot = arguments[index + 1];
                index++;
            }
            else
            {
                Console.Error.WriteLine($"Unknown argument: {arguments[index]}");
                return 2;
            }
        }
        sourceRoot ??= DefaultSourceRoot();

        string fullAssemblyPath = Path.GetFullPath(productionAssemblyPath);
        if (!File.Exists(fullAssemblyPath))
        {
            Console.Error.WriteLine($"Production assembly does not exist: {fullAssemblyPath}");
            return 2;
        }
        if (!File.Exists(Path.Combine(sourceRoot, "ExecutionManager.cs")))
        {
            Console.Error.WriteLine($"Source root does not contain ExecutionManager.cs; pass --source-root <mod-source-dir>: {sourceRoot}");
            return 2;
        }

        try
        {
            byte[] snapshot = FarmhandHandlerSplitContractTests.CaptureAndVerifySnapshot(expectedSha256, fullAssemblyPath);
            FarmhandHandlerSplitContractTests.AssertByteAlteredAssemblyRejected(expectedSha256, fullAssemblyPath);
            FarmhandHandlerSplitContractTests.RunSourceChecks(sourceRoot);
            FarmhandHandlerSplitContractTests.RunCompiledChecks(snapshot);
            Console.WriteLine("Farmhand handler-split contract passed: family-owned ExecutionManager.*Handlers.cs partial units, one ExecutionManager authority, typed router calls.");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception.Message);
            return 1;
        }
    }

    // Contract executables build into integrations/stardew/tests/bin/<cfg>/net6.0/,
    // so four parent segments reach the Mod source root.
    private static string DefaultSourceRoot()
        => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
}
