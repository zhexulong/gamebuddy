using System.Buffers.Binary;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

/// <summary>
/// Lane B contract: the ordinary Farmhand native handlers are family-split
/// across ExecutionManager.*Handlers.cs partial units composing one partial
/// ExecutionManager, while FarmhandActionRouter registrations still call the
/// same typed RequestLocal methods. Both source and compiled checks fail
/// closed if handler bodies collapse back into ExecutionManager.cs, or if a
/// second execution authority (another type declaring RequestLocal handlers,
/// the snapshot authority, or the receipt ledger) is introduced.
/// </summary>
internal static class FarmhandHandlerSplitContractTests
{
    private const string Namespace = "GameBuddy.Stardew";
    private const string ExecutionManagerTypeName = "ExecutionManager";
    private const string RouterTypeName = "FarmhandActionRouter";
    private const string CoreFile = "ExecutionManager.cs";
    private const string RouterFile = "FarmhandActionRouter.cs";

    // Canonical family split: file suffix -> RequestLocal methods whose bodies
    // must live in exactly that partial unit. RequestLocalDoorTransition is
    // private and only called from within the Movement family.
    private static readonly Dictionary<string, string[]> FamilyMethods = new(StringComparer.Ordinal)
    {
        ["MovementHandlers"] = new[] { "RequestLocalMove", "RequestLocalTravel", "RequestLocalEnterExit", "RequestLocalDoorTransition" },
        ["FarmingConstructionHandlers"] = new[]
        {
            "RequestLocalRefillWateringCan", "RequestLocalWaterCrop", "RequestLocalHarvestCrop", "RequestLocalPlantSeed",
            "RequestLocalPlaceWoodFence", "RequestLocalPlaceCrabPot", "RequestLocalBaitCrabPot", "RequestLocalFertilizeTile",
            "RequestLocalClearDebris",
        },
        ["GatheringHandlers"] = new[] { "RequestLocalPickupForage", "RequestLocalPickupItem" },
        ["MachinesAnimalsItemsHandlers"] = new[]
        {
            "RequestLocalLoadCoffeeIntoKeg", "RequestLocalCollectCoffeeFromKeg", "RequestLocalInspectMachine", "RequestLocalUseItem",
            "RequestLocalFeedAnimal", "RequestLocalCollectAnimalProduct", "RequestLocalPetAnimal", "RequestLocalInspectNpcRelationship",
        },
        ["ResourceToolHandlers"] = new[]
        {
            "RequestLocalChopTreeSource", "RequestLocalBreakRockSource", "RequestLocalDigArtifactSpot", "RequestLocalClearHoeDirt",
            "RequestLocalTillSoil", "RequestLocalEquipTool",
        },
    };

    // Canonical router registrations: action id -> typed ExecutionManager method.
    private static readonly (string Action, string Method)[] RouterRegistrations = new[]
    {
        ("move_to_tile", "RequestLocalMove"),
        ("enter_exit", "RequestLocalEnterExit"),
        ("travel", "RequestLocalTravel"),
        ("till_soil", "RequestLocalTillSoil"),
        ("pickup_forage", "RequestLocalPickupForage"),
        ("pickup_item", "RequestLocalPickupItem"),
        ("water_crop", "RequestLocalWaterCrop"),
        ("harvest_crop", "RequestLocalHarvestCrop"),
        ("plant_seed", "RequestLocalPlantSeed"),
        ("fertilize_tile", "RequestLocalFertilizeTile"),
        ("place_wood_fence", "RequestLocalPlaceWoodFence"),
        ("place_crab_pot", "RequestLocalPlaceCrabPot"),
        ("bait_crab_pot", "RequestLocalBaitCrabPot"),
        ("clear_debris", "RequestLocalClearDebris"),
        ("machine_inspect", "RequestLocalInspectMachine"),
        ("machine_load", "RequestLocalLoadCoffeeIntoKeg"),
        ("machine_collect_output", "RequestLocalCollectCoffeeFromKeg"),
        ("npc_relationship", "RequestLocalInspectNpcRelationship"),
        ("pet_animal", "RequestLocalPetAnimal"),
        ("collect_animal_product", "RequestLocalCollectAnimalProduct"),
        ("feed_animal", "RequestLocalFeedAnimal"),
        ("use_item", "RequestLocalUseItem"),
        ("refill_watering_can", "RequestLocalRefillWateringCan"),
        ("clear_hoedirt", "RequestLocalClearHoeDirt"),
        ("dig_artifact_spot", "RequestLocalDigArtifactSpot"),
        ("break_rock_source", "RequestLocalBreakRockSource"),
        ("chop_tree_source", "RequestLocalChopTreeSource"),
        ("equip_tool", "RequestLocalEquipTool"),
    };

    private static readonly string[] ExpectedAllHandlerMethods = FamilyMethods.Values.SelectMany(methods => methods).Distinct(StringComparer.Ordinal).ToArray();
    private static readonly string[] ExpectedPublicHandlerMethods = ExpectedAllHandlerMethods
        .Where(method => method != "RequestLocalDoorTransition")
        .ToArray();

    private static readonly Regex HandlerDefinitionPattern = new(
        @"^\s*(?:public|private|internal|protected)\s+LocalExecutionReceipt\s+(?<name>RequestLocal[A-Za-z0-9_]+)\s*\(",
        RegexOptions.CultureInvariant);

    private static readonly Regex RouterRegistrationPattern = new(
        @"new DelegateActionHandler\(""(?<action>[a-z0-9_]+)""",
        RegexOptions.CultureInvariant);

    private static readonly Regex RequestLocalCallPattern = new(
        @"(?<receiver>[A-Za-z0-9_]+)\.(?<name>RequestLocal[A-Za-z0-9_]+)\s*\(",
        RegexOptions.CultureInvariant);

    private static readonly Regex LowercaseSha256 = new("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);

    // ------------------------------------------------------------------ binding

    internal static byte[] CaptureAndVerifySnapshot(string expectedSha256, string productionAssemblyPath)
    {
        byte[] expectedHash = ParseExpectedSha256(expectedSha256);
        byte[] snapshot = ReadSnapshot(productionAssemblyPath);
        byte[] actualHash = SHA256.HashData(snapshot);
        if (!CryptographicOperations.FixedTimeEquals(expectedHash, actualHash))
            throw new InvalidOperationException("The canonical GameBuddy.Stardew assembly does not match the supplied expected SHA-256.");

        using MemoryStream identityStream = new(snapshot, writable: false);
        using PEReader peReader = new(identityStream, PEStreamOptions.LeaveOpen);
        if (!peReader.HasMetadata)
            throw new InvalidOperationException("The canonical GameBuddy.Stardew assembly must be a managed PE.");
        MetadataReader reader = peReader.GetMetadataReader();
        string assemblyName = reader.GetString(reader.GetAssemblyDefinition().Name);
        if (assemblyName != "GameBuddy.Stardew")
            throw new InvalidOperationException($"The canonical assembly must be named GameBuddy.Stardew; found {assemblyName}.");
        return snapshot;
    }

    internal static void AssertByteAlteredAssemblyRejected(string expectedSha256, string canonicalAssemblyPath)
    {
        byte[] expectedHash = ParseExpectedSha256(expectedSha256);
        string alteredAssemblyPath = Path.Combine(Path.GetTempPath(), $"gamebuddy-stardew-handler-split-byte-altered-{Guid.NewGuid():N}.dll");
        try
        {
            byte[] canonicalSnapshot = ReadSnapshot(canonicalAssemblyPath);
            File.WriteAllBytes(alteredAssemblyPath, canonicalSnapshot.Concat(new byte[] { 0 }).ToArray());
            byte[] alteredSnapshot = ReadSnapshot(alteredAssemblyPath);
            try
            {
                byte[] actualHash = SHA256.HashData(alteredSnapshot);
                if (!CryptographicOperations.FixedTimeEquals(expectedHash, actualHash))
                    return;
            }
            catch (CryptographicException)
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

    private static byte[] ReadSnapshot(string path)
    {
        using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        using MemoryStream snapshot = new();
        stream.CopyTo(snapshot);
        return snapshot.ToArray();
    }

    // ------------------------------------------------------------ source checks

    internal static void RunSourceChecks(string sourceRoot)
    {
        string[] sourceFiles = Directory.GetFiles(sourceRoot, "*.cs", SearchOption.TopDirectoryOnly)
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        string corePath = Path.Combine(sourceRoot, CoreFile);
        Assert(File.Exists(corePath), $"Source root must contain {CoreFile}: {sourceRoot}.");
        string routerPath = Path.Combine(sourceRoot, RouterFile);
        Assert(File.Exists(routerPath), $"Source root must contain {RouterFile}: {sourceRoot}.");

        HashSet<string> expectedFamilyFiles = FamilyMethods.Keys
            .Select(suffix => $"ExecutionManager.{suffix}.cs")
            .ToHashSet(StringComparer.Ordinal);

        // (1) The one ExecutionManager authority is declared only as the shared
        //     internal sealed partial class, only in core and family files.
        foreach (string file in sourceFiles)
        {
            string fileName = Path.GetFileName(file);
            foreach (string line in File.ReadAllLines(file))
            {
                if (!Regex.IsMatch(line, @"\bclass\s+ExecutionManager\b"))
                    continue;
                bool isCore = fileName == CoreFile;
                bool isFamily = expectedFamilyFiles.Contains(fileName);
                Assert(isCore || isFamily,
                    $"{fileName} must not declare a second ExecutionManager surface; the single authority lives only in {CoreFile} and the family files.");
                Assert(line.TrimStart().StartsWith("internal sealed partial class ExecutionManager", StringComparison.Ordinal),
                    $"{fileName} must declare the exact 'internal sealed partial class ExecutionManager' partial unit; found: {line.TrimStart()}.");
            }
        }

        // (2) The family file set is exact: every expected file declares the
        //     shared partial unit, and no other ExecutionManager.*.cs exists.
        string[] actualFamilyFiles = sourceFiles
            .Select(path => Path.GetFileName(path)!)
            .Where(name => name.StartsWith("ExecutionManager.", StringComparison.Ordinal)
                && name.EndsWith(".cs", StringComparison.Ordinal)
                && name != CoreFile)
            .ToArray();
        AssertSetEqual(actualFamilyFiles, expectedFamilyFiles,
            $"The family handler file set must be exactly {string.Join(", ", expectedFamilyFiles.OrderBy(name => name, StringComparer.Ordinal))}.");
        foreach (string fileName in expectedFamilyFiles)
        {
            Assert(File.Exists(Path.Combine(sourceRoot, fileName)), $"Family handler file must exist: {fileName}.");
        }

        // (3) Handler bodies: each expected method is defined exactly once in
        //     its family file; core defines none; no unexpected handler exists
        //     anywhere in the Mod sources.
        Dictionary<string, List<string>> definitionsByFile = new(StringComparer.Ordinal);
        foreach (string file in sourceFiles)
        {
            string fileName = Path.GetFileName(file);
            List<string> definitions = new();
            foreach (string line in File.ReadAllLines(file))
            {
                Match match = HandlerDefinitionPattern.Match(line);
                if (match.Success)
                    definitions.Add(match.Groups["name"].Value);
            }
            definitionsByFile[fileName] = definitions;
        }

        Assert(!definitionsByFile[CoreFile].Any(),
            $"Handler bodies must not collapse back into {CoreFile}; found: {string.Join(", ", definitionsByFile[CoreFile])}.");

        foreach ((string suffix, string[] methods) in FamilyMethods)
        {
            string fileName = $"ExecutionManager.{suffix}.cs";
            foreach (string method in methods)
            {
                string[] locations = definitionsByFile
                    .Where(pair => pair.Value.Contains(method, StringComparer.Ordinal))
                    .Select(pair => pair.Key)
                    .ToArray();
                Assert(locations.Length == 1 && locations[0] == fileName,
                    $"{method} must be defined exactly once, in {fileName}; found in: {string.Join(", ", locations)}.");
            }
        }
        foreach ((string fileName, List<string> definitions) in definitionsByFile)
        {
            foreach (string method in definitions)
            {
                Assert(ExpectedAllHandlerMethods.Contains(method),
                    $"{fileName} defines handler {method} outside the canonical family set; a second execution authority must not exist.");
                string expectedFile = FamilyMethods
                    .First(pair => pair.Value.Contains(method, StringComparer.Ordinal))
                    .Key;
                Assert(fileName == $"ExecutionManager.{expectedFile}.cs",
                    $"{method} must be defined in ExecutionManager.{expectedFile}.cs; found in {fileName}.");
            }
        }

        AssertRouterWiring(routerPath);
    }

    private static void AssertRouterWiring(string routerPath)
    {
        string[] lines = File.ReadAllLines(routerPath);
        Dictionary<string, string> expectedByAction = RouterRegistrations.ToDictionary(pair => pair.Action, pair => pair.Method, StringComparer.Ordinal);

        // Each registration block must call the typed RequestLocal method on
        // the single 'exec' ExecutionManager parameter.
        List<string> registeredActions = new();
        int index = 0;
        while (index < lines.Length)
        {
            Match opener = RouterRegistrationPattern.Match(lines[index]);
            if (!opener.Success)
            {
                index++;
                continue;
            }

            string action = opener.Groups["action"].Value;
            registeredActions.Add(action);
            Assert(expectedByAction.ContainsKey(action), $"FarmhandActionRouter registers unknown action {action}.");
            string expectedMethod = expectedByAction[action];

            List<string> blockLines = new();
            while (index < lines.Length)
            {
                blockLines.Add(lines[index]);
                if (lines[index].Contains("));", StringComparison.Ordinal))
                    break;
                index++;
            }
            index++;
            string block = string.Join(Environment.NewLine, blockLines);
            Assert(block.Contains($"exec.{expectedMethod}(", StringComparison.Ordinal),
                $"FarmhandActionRouter registration for {action} must call exec.{expectedMethod}(...) on the ExecutionManager parameter.");
        }
        AssertSetEqual(registeredActions, expectedByAction.Keys,
            "FarmhandActionRouter must register exactly the canonical action set, once each.");

        // Every RequestLocal member access in the router targets the same
        // 'exec' ExecutionManager parameter, and the called set is exactly the
        // public family handler methods.
        HashSet<string> calledMethods = new(StringComparer.Ordinal);
        foreach (string line in lines)
        {
            foreach (Match match in RequestLocalCallPattern.Matches(line))
            {
                Assert(match.Groups["receiver"].Value == "exec",
                    $"FarmhandActionRouter must call RequestLocal only on the exec ExecutionManager parameter; found receiver '{match.Groups["receiver"].Value}' in: {line.Trim()}.");
                calledMethods.Add(match.Groups["name"].Value);
            }
        }
        AssertSetEqual(calledMethods, ExpectedPublicHandlerMethods,
            "FarmhandActionRouter must call exactly the public family handler methods (no second dispatch surface).");
    }

    // --------------------------------------------------------- compiled checks

    internal static void RunCompiledChecks(byte[] snapshot)
    {
        using MemoryStream stream = new(snapshot, writable: false);
        using PEReader peReader = new(stream, PEStreamOptions.LeaveOpen);
        MetadataReader reader = peReader.GetMetadataReader();

        // (1) Exactly one ExecutionManager type: partial units merge, so a
        //     second authority would surface as an additional type.
        TypeDefinitionHandle[] executionManagerTypes = reader.TypeDefinitions
            .Where(handle => IsType(reader, handle, ExecutionManagerTypeName))
            .ToArray();
        Assert(executionManagerTypes.Length == 1,
            $"Compiled assembly must define exactly one ExecutionManager type; found {executionManagerTypes.Length}.");
        TypeDefinitionHandle executionManager = executionManagerTypes[0];

        // (2) The one type carries exactly the family handler surface:
        //     28 public + 1 private RequestLocalDoorTransition.
        string[] handlerMethods = reader.GetTypeDefinition(executionManager).GetMethods()
            .Select(reader.GetMethodDefinition)
            .Where(method => reader.GetString(method.Name).StartsWith("RequestLocal", StringComparison.Ordinal))
            .Select(method => reader.GetString(method.Name))
            .ToArray();
        AssertSetEqual(handlerMethods, ExpectedAllHandlerMethods,
            "Compiled ExecutionManager must define exactly the family handler methods.");
        int publicHandlerCount = reader.GetTypeDefinition(executionManager).GetMethods()
            .Select(reader.GetMethodDefinition)
            .Count(method => reader.GetString(method.Name).StartsWith("RequestLocal", StringComparison.Ordinal)
                && (method.Attributes & MethodAttributes.Public) != 0);
        Assert(publicHandlerCount == ExpectedPublicHandlerMethods.Length,
            $"Compiled ExecutionManager must expose exactly {ExpectedPublicHandlerMethods.Length} public RequestLocal handlers; found {publicHandlerCount}.");

        // (3) No other type declares handler methods, the snapshot authority,
        //     or the receipt ledger: no second authority exists.
        bool ledgerFound = false;
        foreach (TypeDefinitionHandle handle in reader.TypeDefinitions)
        {
            TypeDefinition type = reader.GetTypeDefinition(handle);
            foreach (MethodDefinition method in type.GetMethods().Select(reader.GetMethodDefinition))
            {
                string methodName = reader.GetString(method.Name);
                if (methodName.StartsWith("RequestLocal", StringComparison.Ordinal) && handle != executionManager)
                    throw new InvalidOperationException($"Second execution authority {GetFullTypeName(reader, handle)} declares handler {methodName}.");
                if (methodName == "CreateBridgeSnapshot" && handle != executionManager)
                    throw new InvalidOperationException($"Second execution authority {GetFullTypeName(reader, handle)} declares {methodName}.");
            }
            foreach (FieldDefinition field in type.GetFields().Select(reader.GetFieldDefinition))
            {
                if (reader.GetString(field.Name) != "receiptsByRequestId")
                    continue;
                Assert(handle == executionManager,
                    $"Second execution authority {GetFullTypeName(reader, handle)} declares the receiptsByRequestId ledger.");
                ledgerFound = true;
            }
        }
        Assert(ledgerFound, "Compiled ExecutionManager must declare the receiptsByRequestId ledger.");

        // (4) Every RequestLocal call site in the whole assembly targets the
        //     single ExecutionManager type.
        foreach (MemberReferenceHandle handle in reader.MemberReferences)
        {
            MemberReference memberReference = reader.GetMemberReference(handle);
            if (!reader.GetString(memberReference.Name).StartsWith("RequestLocal", StringComparison.Ordinal))
                continue;
            string parent = GetMemberReferenceParentTypeName(reader, memberReference);
            Assert(parent == $"{Namespace}.{ExecutionManagerTypeName}",
                $"RequestLocal call site {reader.GetString(memberReference.Name)} targets {parent} instead of the single ExecutionManager.");
        }

        // (5) The compiled router (including compiler-generated closure units)
        //     calls exactly the typed family methods on the one authority.
        TypeDefinitionHandle router = FindType(reader, RouterTypeName);
        HashSet<string> routerCalledMethods = new(StringComparer.Ordinal);
        int routerCallCount = 0;
        foreach (TypeDefinitionHandle handle in EnumerateSelfAndNested(reader, router))
        {
            foreach (MethodDefinitionHandle methodHandle in reader.GetTypeDefinition(handle).GetMethods())
            {
                MethodDefinition method = reader.GetMethodDefinition(methodHandle);
                if (method.RelativeVirtualAddress == 0)
                    continue;
                MethodBodyBlock body = peReader.GetMethodBody(method.RelativeVirtualAddress);
                if (body.GetILBytes() is not { } il)
                    throw new InvalidOperationException($"Compiled router method {reader.GetString(method.Name)} has no IL body.");
                foreach (IlInstruction instruction in ReadInstructions(il.ToArray()))
                {
                    if (instruction.OpCode != OpCodes.Call && instruction.OpCode != OpCodes.Callvirt)
                        continue;
                    string targetName = GetMethodName(reader, instruction.Target);
                    if (!targetName.StartsWith("RequestLocal", StringComparison.Ordinal))
                        continue;
                    Assert(GetDeclaringTypeFullName(reader, instruction.Target) == $"{Namespace}.{ExecutionManagerTypeName}",
                        $"Compiled router calls {targetName} on a type other than the single ExecutionManager.");
                    routerCalledMethods.Add(targetName);
                    routerCallCount++;
                }
            }
        }
        Assert(routerCallCount == RouterRegistrations.Length,
            $"Compiled router must make exactly {RouterRegistrations.Length} typed RequestLocal calls; found {routerCallCount}.");
        AssertSetEqual(routerCalledMethods, ExpectedPublicHandlerMethods,
            "Compiled router must call exactly the public family handler methods.");
    }

    private static TypeDefinitionHandle FindType(MetadataReader reader, string name)
    {
        foreach (TypeDefinitionHandle handle in reader.TypeDefinitions)
        {
            if (IsType(reader, handle, name))
                return handle;
        }
        throw new InvalidOperationException($"Compiled production assembly does not define {Namespace}.{name}.");
    }

    private static bool IsType(MetadataReader reader, TypeDefinitionHandle handle, string name)
    {
        TypeDefinition type = reader.GetTypeDefinition(handle);
        return reader.GetString(type.Namespace) == Namespace && reader.GetString(type.Name) == name;
    }

    private static string GetFullTypeName(MetadataReader reader, TypeDefinitionHandle handle)
    {
        TypeDefinition type = reader.GetTypeDefinition(handle);
        return $"{reader.GetString(type.Namespace)}.{reader.GetString(type.Name)}";
    }

    private static string GetFullTypeName(MetadataReader reader, TypeReferenceHandle handle)
    {
        TypeReference type = reader.GetTypeReference(handle);
        return $"{reader.GetString(type.Namespace)}.{reader.GetString(type.Name)}";
    }

    private static string GetMemberReferenceParentTypeName(MetadataReader reader, MemberReference memberReference)
    {
        EntityHandle parent = memberReference.Parent;
        return parent.Kind switch
        {
            HandleKind.TypeDefinition => GetFullTypeName(reader, (TypeDefinitionHandle)parent),
            HandleKind.TypeReference => GetFullTypeName(reader, (TypeReferenceHandle)parent),
            _ => throw new InvalidOperationException($"Unsupported RequestLocal call-site parent kind {parent.Kind}."),
        };
    }

    private static IEnumerable<TypeDefinitionHandle> EnumerateSelfAndNested(MetadataReader reader, TypeDefinitionHandle root)
    {
        Queue<TypeDefinitionHandle> pending = new();
        pending.Enqueue(root);
        while (pending.Count > 0)
        {
            TypeDefinitionHandle current = pending.Dequeue();
            yield return current;
            foreach (TypeDefinitionHandle nested in reader.GetTypeDefinition(current).GetNestedTypes())
                pending.Enqueue(nested);
        }
    }

    private static EntityHandle ResolveMethodSpecification(MetadataReader reader, EntityHandle method)
        => method.Kind == HandleKind.MethodSpecification
            ? reader.GetMethodSpecification((MethodSpecificationHandle)method).Method
            : method;

    private static string GetMethodName(MetadataReader reader, EntityHandle method)
    {
        EntityHandle resolved = ResolveMethodSpecification(reader, method);
        return resolved.Kind switch
        {
            HandleKind.MethodDefinition => reader.GetString(reader.GetMethodDefinition((MethodDefinitionHandle)resolved).Name),
            HandleKind.MemberReference => reader.GetString(reader.GetMemberReference((MemberReferenceHandle)resolved).Name),
            _ => throw new InvalidOperationException($"Unsupported method target kind {resolved.Kind}."),
        };
    }

    private static string GetDeclaringTypeFullName(MetadataReader reader, EntityHandle method)
    {
        EntityHandle resolved = ResolveMethodSpecification(reader, method);
        return resolved.Kind switch
        {
            HandleKind.MethodDefinition => GetFullTypeName(reader, reader.GetMethodDefinition((MethodDefinitionHandle)resolved).GetDeclaringType()),
            HandleKind.MemberReference => GetMemberReferenceParentTypeName(reader, reader.GetMemberReference((MemberReferenceHandle)resolved)),
            _ => throw new InvalidOperationException($"Unsupported method target kind {resolved.Kind}."),
        };
    }

    // ---------------------------------------------------------------- IL reader

    private static IReadOnlyList<IlInstruction> ReadInstructions(byte[] il)
    {
        Dictionary<short, OpCode> opcodes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.FieldType == typeof(OpCode))
            .Select(field => (OpCode)field.GetValue(null)!)
            .ToDictionary(opcode => opcode.Value);
        List<IlInstruction> instructions = new();
        int offset = 0;
        while (offset < il.Length)
        {
            int instructionOffset = offset;
            short value = il[offset++] == 0xFE ? (short)(0xFE00 | il[offset++]) : il[offset - 1];
            if (!opcodes.TryGetValue(value, out OpCode opcode))
                throw new InvalidOperationException($"Unknown IL opcode 0x{value:X4}.");
            int operandOffset = offset;
            int operandSize = GetOperandSize(opcode.OperandType, il, operandOffset);
            int operand = operandSize is sizeof(byte) or sizeof(short) or sizeof(int)
                ? operandSize switch
                {
                    sizeof(byte) => il[operandOffset],
                    sizeof(short) => BinaryPrimitives.ReadUInt16LittleEndian(il.AsSpan(operandOffset, sizeof(short))),
                    _ => BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(operandOffset, sizeof(int))),
                }
                : 0;
            EntityHandle target = opcode.OperandType is OperandType.InlineMethod
                ? MetadataTokens.EntityHandle(operand)
                : default;
            instructions.Add(new(instructionOffset, opcode, operand, target));
            offset += operandSize;
        }
        return instructions;
    }

    private static int GetOperandSize(OperandType operandType, byte[] il, int offset) => operandType switch
    {
        OperandType.InlineNone => 0,
        OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
        OperandType.InlineVar => 2,
        OperandType.InlineI or OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineMethod
            or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
            or OperandType.ShortInlineR => 4,
        OperandType.InlineI8 or OperandType.InlineR => 8,
        OperandType.InlineSwitch => sizeof(int) + BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(offset, sizeof(int))) * sizeof(int),
        _ => throw new InvalidOperationException($"Unsupported IL operand type {operandType}."),
    };

    private readonly record struct IlInstruction(int Offset, OpCode OpCode, int Operand, EntityHandle Target);

    // ------------------------------------------------------------------ helpers

    private static void AssertSetEqual(IEnumerable<string> actual, IEnumerable<string> expected, string message)
    {
        string[] actualSorted = actual.Distinct(StringComparer.Ordinal).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        string[] expectedSorted = expected.Distinct(StringComparer.Ordinal).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        Assert(actualSorted.SequenceEqual(expectedSorted, StringComparer.Ordinal),
            $"{message} Expected: {string.Join(", ", expectedSorted)}; Actual: {string.Join(", ", actualSorted)}.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
