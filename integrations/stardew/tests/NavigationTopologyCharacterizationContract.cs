using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

/// <summary>
/// Static C# contract for the Task 5A probe binary. It verifies that:
/// - The production GameBuddy.Stardew assembly has the expected SHA-256 and name.
/// - The probe assembly references GameBuddy.Stardew by assembly reference, not
///   a copied source type.
/// - Exactly one probe IL call/callvirt resolves to the exact internal production
///   method GameBuddy.Stardew.Navigation.Game1NavigationWorldSource.TryCreateCurrentOrdinaryWarpTopology,
///   bound by a fixed fully resolved semantic signature shape and exact production
///   assembly identity (name, version, culture, public key blob, flags) through
///   the MemberReference parent TypeReference's AssemblyReference resolution scope.
/// - No dynamic member discovery or reflective invocation occurs in the probe.
/// - The probe metadata contains no local extractor anchors.
/// - The probe assembly name is exactly the friend name.
/// </summary>
internal static class NavigationTopologyCharacterizationContract
{
    internal const string ExpectedProductionAssemblyName = "GameBuddy.Stardew";
    internal const string ExpectedProbeAssemblyName = "GameBuddy.Stardew.NavigationTopologyCharacterization";
    internal const string TargetTypeNamespace = "GameBuddy.Stardew.Navigation";
    internal const string TargetTypeName = "Game1NavigationWorldSource";
    internal const string TargetMethodName = "TryCreateCurrentOrdinaryWarpTopology";

    private static readonly Regex LowercaseSha256 = new("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);

    /// <summary>
    /// ECMA-335 opcode to OperandType lookup, built once from
    /// System.Reflection.Emit.OpCodes static fields.
    /// </summary>
    private static readonly Dictionary<int, OperandType> s_operandTypes = BuildOperandTypeTable();

    private static Dictionary<int, OperandType> BuildOperandTypeTable()
    {
        var table = new Dictionary<int, OperandType>();
        foreach (FieldInfo field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            var opCode = (OpCode)field.GetValue(null)!;
            // OpCode.Value is a signed Int16. Normalize it to the unsigned
            // byte stream representation used by ScanILBytes so 0xFE-prefixed
            // opcodes (for example constrained. = 0xFE16) resolve correctly.
            table[unchecked((ushort)opCode.Value)] = opCode.OperandType;
        }
        return table;
    }

    /// <summary>
    /// Validates the probe binary against the production binary. Returns 0 on
    /// success, 1 on validation failure (with error messages written to
    /// <paramref name="error"/>).
    /// </summary>
    internal static int Validate(
        string expectedSha256Hex,
        string productionDllPath,
        string probeDllPath,
        TextWriter error)
    {
        // ---- Self-test: verify the IL decoder rejects malformed input ----
        {
            string? selfTestError = RunSelfTest();
            if (selfTestError != null)
            {
                error.WriteLine($"ERROR: Contract self-test failed: {selfTestError}");
                return 1;
            }
        }

        // ---- Validate arguments ----
        if (string.IsNullOrWhiteSpace(expectedSha256Hex) || !LowercaseSha256.IsMatch(expectedSha256Hex))
        {
            error.WriteLine("ERROR: expectedSha256 must be exactly 64 lowercase hexadecimal characters.");
            return 1;
        }
        if (string.IsNullOrWhiteSpace(productionDllPath) || !File.Exists(productionDllPath))
        {
            error.WriteLine($"ERROR: production DLL does not exist: {productionDllPath}");
            return 1;
        }
        if (string.IsNullOrWhiteSpace(probeDllPath) || !File.Exists(probeDllPath))
        {
            error.WriteLine($"ERROR: probe DLL does not exist: {probeDllPath}");
            return 1;
        }

        // ---- 1. Verify production SHA-256 ----
        byte[] expectedHash = Convert.FromHexString(expectedSha256Hex);
        byte[] productionBytes = ReadSnapshot(productionDllPath);
        byte[] actualHash = SHA256.HashData(productionBytes);
        if (!CryptographicOperations.FixedTimeEquals(expectedHash, actualHash))
        {
            error.WriteLine($"ERROR: Production SHA-256 mismatch. Expected: {expectedSha256Hex}, Actual: {Convert.ToHexString(actualHash).ToLowerInvariant()}");
            return 1;
        }

        // ---- 2. Verify production assembly name and extract target method signature ----
        string productionAssemblyName;
        bool productionTargetSignatureValid;
        ProductionAssemblyIdentity productionIdentity;
        using (var productionPe = new PEReader(new MemoryStream(productionBytes, writable: false), PEStreamOptions.LeaveOpen))
        {
            if (!productionPe.HasMetadata)
            {
                error.WriteLine("ERROR: Production assembly is not a managed PE.");
                return 1;
            }
            MetadataReader productionReader = productionPe.GetMetadataReader();
            AssemblyDefinition productionAsmDef = productionReader.GetAssemblyDefinition();
            productionAssemblyName = productionReader.GetString(productionAsmDef.Name);
            if (productionAssemblyName != ExpectedProductionAssemblyName)
            {
                error.WriteLine($"ERROR: Production assembly name mismatch. Expected: {ExpectedProductionAssemblyName}, Found: {productionAssemblyName}");
                return 1;
            }

            // Capture the exact production assembly identity for scope binding.
            productionIdentity = new ProductionAssemblyIdentity(productionAsmDef, productionReader);

            // Validate the unique production target against the fixed semantic
            // signature shape. Raw blobs cannot cross-compare TypeDef-coded
            // production signatures with TypeRef-coded external probe signatures.
            productionTargetSignatureValid = ValidateUniqueProductionTargetSignature(productionReader, productionIdentity);
        }

        // ---- 3. Load probe DLL ----
        byte[] probeBytes = ReadSnapshot(probeDllPath);
        using var probePe = new PEReader(new MemoryStream(probeBytes, writable: false), PEStreamOptions.LeaveOpen);
        if (!probePe.HasMetadata)
        {
            error.WriteLine("ERROR: Probe assembly is not a managed PE.");
            return 1;
        }
        MetadataReader probeReader = probePe.GetMetadataReader();

        // ---- 4. Verify probe assembly name ----
        string probeAssemblyName = probeReader.GetString(probeReader.GetAssemblyDefinition().Name);
        if (probeAssemblyName != ExpectedProbeAssemblyName)
        {
            error.WriteLine($"ERROR: Probe assembly name mismatch. Expected: {ExpectedProbeAssemblyName}, Found: {probeAssemblyName}");
            return 1;
        }

        // ---- 5. Check probe references GameBuddy.Stardew by assembly reference ----
        bool hasProductionReference = false;
        foreach (AssemblyReferenceHandle refHandle in probeReader.AssemblyReferences)
        {
            AssemblyReference asmRef = probeReader.GetAssemblyReference(refHandle);
            string refName = probeReader.GetString(asmRef.Name);
            if (refName == ExpectedProductionAssemblyName)
            {
                hasProductionReference = true;
                break;
            }
        }
        if (!hasProductionReference)
        {
            error.WriteLine($"ERROR: Probe assembly does not reference {ExpectedProductionAssemblyName}.");
            return 1;
        }

        // ---- 6. Check IL for call/callvirt to the exact production method ----
        // Also check for extraction anchors and reflection/dynamic invocation.
        int targetCallCount = 0;
        var reflectionAnchors = new List<string>();
        var extractionAnchors = new List<string>();

        // Check all metadata references before decoding bodies. This makes the
        // permitted typed identity/readiness surface explicit and rejects a
        // copied extractor or dynamic invocation even when it is not reached
        // by the probe's one direct production call.
        CheckTypeDefinitionsForAnchors(probeReader, extractionAnchors);
        CheckMetadataReferencesForForbiddenConstructs(probeReader, reflectionAnchors, extractionAnchors);

        // Check method bodies for call/callvirt targets and reflection
        if (!productionTargetSignatureValid)
        {
            error.WriteLine("ERROR: Production target semantic signature is invalid.");
            return 1;
        }
        // The scanner's test seam retains its raw-signature parameter, but
        // target calls use the fixed semantic validator below rather than
        // cross-assembly raw blob equality.
        CheckMethodBodies(probePe, probeReader, ref targetCallCount, reflectionAnchors, extractionAnchors, null, productionIdentity);

        if (targetCallCount == 0)
        {
            error.WriteLine($"ERROR: Probe does not contain a call/callvirt to {TargetTypeNamespace}.{TargetTypeName}.{TargetMethodName}.");
            return 1;
        }
        if (targetCallCount > 1)
        {
            error.WriteLine($"ERROR: Probe contains {targetCallCount} calls to {TargetTypeName}.{TargetMethodName}; expected exactly 1.");
            return 1;
        }

        // ---- 7. Check no reflection/dynamic invocation ----
        if (reflectionAnchors.Count > 0)
        {
            error.WriteLine($"ERROR: Probe contains reflection/dynamic invocation anchor(s): {string.Join(", ", reflectionAnchors)}");
            return 1;
        }

        // ---- 8. Check no extraction anchors ----
        if (extractionAnchors.Count > 0)
        {
            error.WriteLine($"ERROR: Probe contains extraction anchor(s): {string.Join(", ", extractionAnchors)}");
            return 1;
        }

        error.WriteLine("NavigationTopologyCharacterization.Contract passed.");
        return 0;
    }

    /// <summary>
    /// Validates exactly one production target method against the frozen,
    /// restricted semantic signature shape. The production image is already
    /// SHA-bound, so its internal parameter types must be local TypeDefs.
    /// </summary>
    private static bool ValidateUniqueProductionTargetSignature(
        MetadataReader reader,
        ProductionAssemblyIdentity productionIdentity)
    {
        MethodDefinitionHandle target = default;
        int matches = 0;
        foreach (TypeDefinitionHandle typeHandle in reader.TypeDefinitions)
        {
            TypeDefinition typeDef = reader.GetTypeDefinition(typeHandle);
            string ns = typeDef.Namespace.IsNil ? "" : reader.GetString(typeDef.Namespace);
            if (ns != TargetTypeNamespace || reader.GetString(typeDef.Name) != TargetTypeName)
                continue;

            foreach (MethodDefinitionHandle methodHandle in typeDef.GetMethods())
            {
                MethodDefinition method = reader.GetMethodDefinition(methodHandle);
                if (reader.GetString(method.Name) == TargetMethodName)
                {
                    target = methodHandle;
                    matches++;
                }
            }
        }

        if (matches != 1 || target.IsNil)
            return false;

        MethodDefinition definition = reader.GetMethodDefinition(target);
        return ValidateTargetSemanticSignature(
            reader,
            reader.GetBlobReader(definition.Signature),
            SignatureTypeResolution.ProductionDefinition,
            productionIdentity);
    }

    private enum SignatureTypeResolution
    {
        ProductionDefinition,
        ProbeReference,
    }

    private static bool ValidateTargetSemanticSignature(
        MetadataReader reader,
        BlobReader signature,
        SignatureTypeResolution resolution,
        ProductionAssemblyIdentity productionIdentity)
    {
        try
        {
            // IMAGE_CEE_CS_CALLCONV_HASTHIS | DEFAULT. Reject generic,
            // explicit-this, vararg, property/local/field and every other form.
            if (signature.RemainingBytes < 1 || signature.ReadByte() != 0x20)
                return false;
            if (signature.ReadCompressedInteger() != 3)
                return false;
            if (signature.ReadByte() != (byte)SignatureTypeCode.Boolean)
                return false;

            ValidateClassElement(reader, ref signature, "GameBuddy.Stardew.Navigation", "NavigationDestinationBinding", resolution, productionIdentity);
            if (signature.ReadByte() != (byte)SignatureTypeCode.ByReference)
                return false;
            ValidateClassElement(reader, ref signature, "GameBuddy.Stardew.Navigation", "NavigationOrdinaryWarpTopology", resolution, productionIdentity);
            if (signature.ReadByte() != (byte)SignatureTypeCode.ByReference)
                return false;
            if (signature.ReadByte() != (byte)SignatureTypeCode.String)
                return false;
            return signature.RemainingBytes == 0;
        }
        catch (Exception exception) when (exception is BadImageFormatException or ArgumentException or InvalidOperationException)
        {
            return false;
        }
    }

    private static void ValidateClassElement(
        MetadataReader reader,
        ref BlobReader signature,
        string expectedNamespace,
        string expectedName,
        SignatureTypeResolution resolution,
        ProductionAssemblyIdentity productionIdentity)
    {
        if (signature.RemainingBytes < 1 || signature.ReadByte() != 0x12)
            throw new InvalidOperationException("Expected an exact class signature element.");
        int codedToken = signature.ReadCompressedInteger();
        if (codedToken <= 0)
            throw new InvalidOperationException("TypeDefOrRef coded token is invalid.");

        int tag = codedToken & 0x3;
        int row = codedToken >> 2;
        if (row == 0)
            throw new InvalidOperationException("TypeDefOrRef coded token has no row.");

        if (resolution == SignatureTypeResolution.ProductionDefinition)
        {
            if (tag != 0)
                throw new InvalidOperationException("Production target parameter type must be a local TypeDefinition.");
            TypeDefinition type = reader.GetTypeDefinition(MetadataTokens.TypeDefinitionHandle(row));
            string ns = type.Namespace.IsNil ? "" : reader.GetString(type.Namespace);
            if (ns != expectedNamespace || reader.GetString(type.Name) != expectedName)
                throw new InvalidOperationException("Production target parameter type identity mismatch.");
            return;
        }

        if (tag != 1)
            throw new InvalidOperationException("Probe target parameter type must be a direct TypeReference.");
        TypeReference reference = reader.GetTypeReference(MetadataTokens.TypeReferenceHandle(row));
        string referenceNamespace = reference.Namespace.IsNil ? "" : reader.GetString(reference.Namespace);
        if (referenceNamespace != expectedNamespace || reader.GetString(reference.Name) != expectedName
            || reference.ResolutionScope.Kind != HandleKind.AssemblyReference)
            throw new InvalidOperationException("Probe target parameter type identity or scope mismatch.");
        VerifyAssemblyIdentity(
            reader.GetAssemblyReference((AssemblyReferenceHandle)reference.ResolutionScope),
            reader,
            productionIdentity);
    }

    internal readonly struct ProductionAssemblyIdentity
    {
        internal readonly string Name;
        internal readonly Version? Version;
        internal readonly string Culture;
        internal readonly byte[]? PublicKey;
        internal readonly AssemblyFlags Flags;

        internal ProductionAssemblyIdentity(AssemblyDefinition asmDef, MetadataReader reader)
        {
            Name = reader.GetString(asmDef.Name);
            Version = asmDef.Version;
            Culture = asmDef.Culture.IsNil ? "" : reader.GetString(asmDef.Culture);
            PublicKey = asmDef.PublicKey.IsNil ? null : reader.GetBlobBytes(asmDef.PublicKey);
            Flags = asmDef.Flags;
        }
    }

    private static bool ByteArraysEqual(byte[]? a, byte[]? b)
    {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;
        return a.AsSpan().SequenceEqual(b);
    }

    private static void VerifyAssemblyIdentity(AssemblyReference asmRef, MetadataReader reader, ProductionAssemblyIdentity expected)
    {
        string refName = reader.GetString(asmRef.Name);
        if (refName != expected.Name)
            throw new InvalidOperationException(
                $"Assembly name mismatch in scope binding: expected '{expected.Name}', found '{refName}'.");

        if (!Equals(asmRef.Version, expected.Version))
            throw new InvalidOperationException(
                $"Assembly version mismatch in scope binding: expected '{expected.Version}', found '{asmRef.Version}'.");

        string refCulture = asmRef.Culture.IsNil ? "" : reader.GetString(asmRef.Culture);
        if (refCulture != expected.Culture)
            throw new InvalidOperationException(
                $"Assembly culture mismatch in scope binding: expected '{expected.Culture}', found '{refCulture}'.");

        AssemblyFlags nonKeyReferenceFlags = asmRef.Flags & ~AssemblyFlags.PublicKey;
        AssemblyFlags nonKeyProductionFlags = expected.Flags & ~AssemblyFlags.PublicKey;
        if (nonKeyReferenceFlags != nonKeyProductionFlags)
            throw new InvalidOperationException(
                $"Assembly flags mismatch in scope binding: expected '{nonKeyProductionFlags}', found '{nonKeyReferenceFlags}'.");

        bool referenceCarriesFullKey = (asmRef.Flags & AssemblyFlags.PublicKey) != 0;
        byte[]? referenceKeyOrToken = asmRef.PublicKeyOrToken.IsNil
            ? null
            : reader.GetBlobBytes(asmRef.PublicKeyOrToken);

        if (expected.PublicKey == null)
        {
            if (referenceCarriesFullKey || referenceKeyOrToken != null)
                throw new InvalidOperationException("Unsigned production assembly has a keyed assembly reference.");
            return;
        }

        if (referenceKeyOrToken == null || referenceKeyOrToken.Length == 0)
            throw new InvalidOperationException("Strong-named production assembly reference has no public key or token.");

        byte[] expectedKeyOrToken = referenceCarriesFullKey
            ? expected.PublicKey
            : ComputePublicKeyToken(expected.PublicKey);
        if (!ByteArraysEqual(referenceKeyOrToken, expectedKeyOrToken))
            throw new InvalidOperationException("Assembly public key or token mismatch in scope binding.");
    }

    private static byte[] ComputePublicKeyToken(byte[] publicKey)
    {
        if (publicKey.Length == 0)
            throw new InvalidOperationException("Cannot derive a public-key token from an empty public key.");

        byte[] hash = SHA1.HashData(publicKey);
        byte[] token = new byte[8];
        for (int index = 0; index < token.Length; index++)
            token[index] = hash[hash.Length - 1 - index];
        return token;
    }

    private static byte[] ReadSnapshot(string filePath)
    {
        using FileStream stream = new(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using MemoryStream snapshot = new();
        stream.CopyTo(snapshot);
        return snapshot.ToArray();
    }

    private static void CheckTypeDefinitionsForAnchors(MetadataReader reader, List<string> anchors)
    {
        foreach (TypeDefinitionHandle typeHandle in reader.TypeDefinitions)
        {
            TypeDefinition typeDef = reader.GetTypeDefinition(typeHandle);
            string name = reader.GetString(typeDef.Name);

            // Skip the implicit <Module> type
            if (name == "<Module>")
                continue;

            // Check for forbidden type names
            if (name == "Game1NavigationWorldSource" || name == "NavigationOrdinaryWarpTopology")
            {
                anchors.Add($"type:{name}");
            }
        }
    }

    private static void CheckMetadataReferencesForForbiddenConstructs(
        MetadataReader reader,
        List<string> reflectionAnchors,
        List<string> extractionAnchors)
    {
        foreach (TypeReferenceHandle typeHandle in reader.TypeReferences)
        {
            TypeReference type = reader.GetTypeReference(typeHandle);
            string typeNamespace = type.Namespace.IsNil ? "" : reader.GetString(type.Namespace);
            string typeName = reader.GetString(type.Name);

            // Compiler-generated Assembly*Attribute metadata neither discovers
            // nor invokes members. It is permitted only as metadata; all other
            // reflection types remain rejection anchors.
            if ((typeNamespace == "System.Reflection"
                 && typeName is not ("Assembly" or "Module")
                 && !typeName.StartsWith("Assembly", StringComparison.Ordinal)
                 && !typeName.EndsWith("Attribute", StringComparison.Ordinal)) ||
                typeNamespace == "System.Linq.Expressions" ||
                typeNamespace == "System.Dynamic" ||
                typeNamespace == "Microsoft.CSharp.RuntimeBinder")
            {
                reflectionAnchors.Add($"type:{typeNamespace}.{typeName}");
            }

            if (typeNamespace == "StardewValley" && typeName == "Warp")
                extractionAnchors.Add($"type:{typeNamespace}.{typeName}");
        }

        foreach (MemberReferenceHandle memberHandle in reader.MemberReferences)
        {
            MemberReference member = reader.GetMemberReference(memberHandle);
            if (member.Parent.Kind != HandleKind.TypeReference)
                continue;

            TypeReference parent = reader.GetTypeReference((TypeReferenceHandle)member.Parent);
            string parentNamespace = parent.Namespace.IsNil ? "" : reader.GetString(parent.Namespace);
            string parentName = reader.GetString(parent.Name);
            string memberName = reader.GetString(member.Name);

            if (IsForbiddenReflectionMember(parentNamespace, parentName, memberName))
                reflectionAnchors.Add($"member:{parentNamespace}.{parentName}.{memberName}");
            if (IsForbiddenRawWorldMember(parentNamespace, parentName, memberName))
                extractionAnchors.Add($"member:{parentNamespace}.{parentName}.{memberName}");
        }
    }

    private static bool IsForbiddenReflectionMember(string parentNamespace, string parentName, string memberName)
    {
        if (parentNamespace == "System" && parentName == "Type")
        {
            // C# lowers the approved typeof(T).Assembly identity read through
            // GetTypeFromHandle; op_Equality is a compiler intrinsic emitted by
            // generated metadata/nullability code and cannot discover/invoke a
            // member. All other Type APIs remain forbidden.
            return memberName is not ("get_Assembly" or "GetTypeFromHandle" or "op_Equality");
        }
        if (parentNamespace == "System.Reflection" && parentName.StartsWith("Assembly", StringComparison.Ordinal)
            && parentName.EndsWith("Attribute", StringComparison.Ordinal))
            return memberName != ".ctor";
        if (parentNamespace == "System.Reflection" && parentName == "Assembly")
            return memberName is not ("get_Location" or "get_ManifestModule");
        if (parentNamespace == "System.Reflection" && parentName == "Module")
            return memberName != "get_ModuleVersionId";
        return parentNamespace == "System.Reflection" ||
               parentNamespace == "System.Linq.Expressions" ||
               parentNamespace == "System.Dynamic" ||
               parentNamespace == "Microsoft.CSharp.RuntimeBinder";
    }

    private static bool IsForbiddenRawWorldMember(string parentNamespace, string parentName, string memberName)
    {
        if (parentNamespace != "StardewValley")
            return false;

        return parentName switch
        {
            "Game1" => memberName is not ("get_player" or "get_currentLocation"),
            "GameLocation" => memberName != "get_NameOrUniqueName",
            "Farmer" => memberName is not ("get_currentLocation" or "get_Tile"),
            "Warp" => true,
            _ => false,
        };
    }

    private static void CheckMethodBodies(
        PEReader peReader,
        MetadataReader reader,
        ref int targetCallCount,
        List<string> reflectionAnchors,
        List<string> extractionAnchors,
        byte[]? expectedTargetSignature,
        ProductionAssemblyIdentity productionIdentity)
    {
        foreach (MethodDefinitionHandle methodHandle in reader.MethodDefinitions)
        {
            MethodDefinition methodDef = reader.GetMethodDefinition(methodHandle);

            // Skip methods without IL body
            if ((methodDef.Attributes & (MethodAttributes.Abstract | MethodAttributes.PinvokeImpl)) != 0)
                continue;

            int rva = methodDef.RelativeVirtualAddress;
            if (rva == 0)
                continue;

            // Fail-closed: any malformed or unresolvable body must reject the probe
            MethodBodyBlock bodyBlock = peReader.GetMethodBody(rva);
            DecodeIL(reader, bodyBlock, ref targetCallCount, reflectionAnchors, extractionAnchors, expectedTargetSignature, productionIdentity);
        }
    }

    /// <summary>
    /// Decodes IL bytecode using the ECMA-335 opcode table. Fail-closed: any
    /// unknown opcode, insufficient operand bytes, or invalid token causes an
    /// exception that propagates to reject the probe.
    /// </summary>
    private static void DecodeIL(
        MetadataReader reader,
        MethodBodyBlock body,
        ref int targetCallCount,
        List<string> reflectionAnchors,
        List<string> extractionAnchors,
        byte[]? expectedTargetSignature,
        ProductionAssemblyIdentity productionIdentity)
    {
        ScanILBytes(body.GetILReader(), reader, ref targetCallCount, reflectionAnchors, extractionAnchors, expectedTargetSignature, productionIdentity);
    }

    /// <summary>
    /// Scans raw IL bytes from a <see cref="BlobReader"/>. Fail-closed: any
    /// unknown opcode, insufficient operand bytes, or invalid token causes an
    /// exception. This is the inner scanner that is also exercised by the
    /// contract self-test.
    /// </summary>
    internal static void ScanILBytes(
        BlobReader il,
        MetadataReader reader,
        ref int targetCallCount,
        List<string> reflectionAnchors,
        List<string> extractionAnchors,
        byte[]? expectedTargetSignature,
        ProductionAssemblyIdentity productionIdentity)
    {
        while (il.RemainingBytes > 0)
        {
            int opcodeValue = il.ReadByte();

            // Check for two-byte opcode prefix (0xFE)
            if (opcodeValue == 0xFE)
            {
                if (il.RemainingBytes == 0)
                    throw new InvalidOperationException("Unexpected end of IL after 0xFE prefix.");
                opcodeValue = 0xFE00 | il.ReadByte();
            }

            // Look up the operand type from the ECMA-335 table. Unknown opcodes
            // (including 0xFF, 0xFE without second byte, etc.) are rejected.
            if (!s_operandTypes.TryGetValue(opcodeValue, out OperandType operandType))
                throw new InvalidOperationException($"Unknown IL opcode 0x{opcodeValue:X4}.");

            // A permitted proof has exactly one direct call/callvirt to the
            // production MemberReference. Every callable token is resolved and
            // inspected; unsupported indirect forms fail closed.
            if (opcodeValue == OpCodes.Calli.Value)
            {
                throw new InvalidOperationException("Indirect calli is not permitted in the topology characterization probe.");
            }
            if (opcodeValue == OpCodes.Ldftn.Value || opcodeValue == OpCodes.Ldvirtftn.Value)
            {
                throw new InvalidOperationException("Function-pointer construction is not permitted in the topology characterization probe.");
            }
            if (opcodeValue == OpCodes.Call.Value || opcodeValue == OpCodes.Callvirt.Value)
            {
                InspectMethodToken(
                    reader,
                    ReadMethodToken(ref il, "call/callvirt"),
                    allowDirectTargetCall: true,
                    ref targetCallCount,
                    reflectionAnchors,
                    extractionAnchors,
                    expectedTargetSignature,
                    productionIdentity);
            }
            else if (opcodeValue == OpCodes.Newobj.Value || opcodeValue == OpCodes.Jmp.Value)
            {
                InspectMethodToken(
                    reader,
                    ReadMethodToken(ref il, "callable opcode"),
                    allowDirectTargetCall: false,
                    ref targetCallCount,
                    reflectionAnchors,
                    extractionAnchors,
                    expectedTargetSignature,
                    productionIdentity);
            }
            else if (operandType == OperandType.InlineSwitch)
            {
                // InlineSwitch has a variable-size operand: 4-byte count
                // followed by count * 4 signed-int branch targets.
                SkipInlineSwitch(ref il);
            }
            else
            {
                // Skip the operand bytes based on the operand type
                SkipOperandByType(ref il, operandType);
            }
        }
    }

    /// <summary>
    /// Skips the operand bytes for a given <see cref="OperandType"/>.
    /// Fail-closed: throws if the operand cannot be fully consumed.
    /// </summary>
    private static void SkipOperandByType(ref BlobReader il, OperandType operandType)
    {
        int size = operandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget => 1,
            OperandType.ShortInlineI => 1,
            OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget => 4,
            OperandType.InlineField => 4,
            OperandType.InlineI => 4,
            OperandType.InlineMethod => 4,
            OperandType.InlineSig => 4,
            OperandType.InlineString => 4,
            OperandType.InlineTok => 4,
            OperandType.InlineType => 4,
            OperandType.ShortInlineR => 4,
            OperandType.InlineR => 8,
            OperandType.InlineI8 => 8,
            OperandType.InlineSwitch => throw new InvalidOperationException("InlineSwitch must be handled separately."),
            _ => throw new InvalidOperationException($"Unknown operand type {operandType}."),
        };

        if (il.RemainingBytes < size)
            throw new InvalidOperationException($"Insufficient bytes for operand type {operandType}: need {size}, have {il.RemainingBytes}.");

        for (int i = 0; i < size; i++)
            il.ReadByte();
    }

    /// <summary>
    /// Handles InlineSwitch: reads the 4-byte count, then skips count * 4 bytes.
    /// </summary>
    private static void SkipInlineSwitch(ref BlobReader il)
    {
        if (il.RemainingBytes < 4)
            throw new InvalidOperationException("Insufficient bytes for InlineSwitch count.");
        int switchCount = il.ReadInt32();
        if (switchCount < 0)
            throw new InvalidOperationException("InlineSwitch count cannot be negative.");
        if (switchCount > il.RemainingBytes / 4)
            throw new InvalidOperationException(
                $"Insufficient bytes for InlineSwitch targets: count {switchCount}, remaining {il.RemainingBytes}.");

        int switchSize = switchCount * 4;
        for (int i = 0; i < switchSize; i++)
            il.ReadByte();
    }

    private static int ReadMethodToken(ref BlobReader il, string operation)
    {
        if (il.RemainingBytes < 4)
            throw new InvalidOperationException($"Insufficient bytes for {operation} token.");
        return il.ReadInt32();
    }

    private static void InspectMethodToken(
        MetadataReader reader,
        int token,
        bool allowDirectTargetCall,
        ref int targetCallCount,
        List<string> reflectionAnchors,
        List<string> extractionAnchors,
        byte[]? expectedTargetSignature,
        ProductionAssemblyIdentity productionIdentity)
    {
        Handle handle;
        try
        {
            handle = MetadataTokens.Handle(token);
        }
        catch (Exception exception) when (exception is ArgumentException or BadImageFormatException)
        {
            throw new InvalidOperationException("Invalid callable metadata token.", exception);
        }

        switch (handle.Kind)
        {
            case HandleKind.MemberReference:
                CheckMemberReference(
                    reader,
                    (MemberReferenceHandle)handle,
                    allowDirectTargetCall,
                    ref targetCallCount,
                    reflectionAnchors,
                    extractionAnchors,
                    expectedTargetSignature,
                    productionIdentity);
                return;
            case HandleKind.MethodDefinition:
                CheckMethodDefinition(reader, (MethodDefinitionHandle)handle, reflectionAnchors, extractionAnchors);
                return;
            case HandleKind.MethodSpecification:
                MethodSpecification specification = reader.GetMethodSpecification((MethodSpecificationHandle)handle);
                if (specification.Signature.IsNil || reader.GetBlobBytes(specification.Signature).Length == 0)
                    throw new InvalidOperationException("MethodSpecification has an empty generic instantiation signature.");
                InspectMethodToken(
                    reader,
                    MetadataTokens.GetToken(specification.Method),
                    allowDirectTargetCall: false,
                    ref targetCallCount,
                    reflectionAnchors,
                    extractionAnchors,
                    expectedTargetSignature,
                    productionIdentity);
                return;
            default:
                throw new InvalidOperationException($"Unsupported callable metadata token kind: {handle.Kind}.");
        }
    }

    private static void CheckMemberReference(
        MetadataReader reader,
        MemberReferenceHandle memberRefHandle,
        bool allowDirectTargetCall,
        ref int targetCallCount,
        List<string> reflectionAnchors,
        List<string> extractionAnchors,
        byte[]? expectedTargetSignature,
        ProductionAssemblyIdentity productionIdentity)
    {
        MemberReference memberRef = reader.GetMemberReference(memberRefHandle);
        string memberName = reader.GetString(memberRef.Name);

        Handle parent = memberRef.Parent;

        string? parentNamespace = null;
        string? parentName = null;
        HandleKind parentKind = parent.Kind;

        if (parentKind == HandleKind.TypeReference)
        {
            TypeReference typeRef = reader.GetTypeReference((TypeReferenceHandle)parent);
            parentNamespace = typeRef.Namespace.IsNil ? "" : reader.GetString(typeRef.Namespace);
            parentName = reader.GetString(typeRef.Name);
        }
        else if (parentKind == HandleKind.TypeDefinition)
        {
            TypeDefinition typeDef = reader.GetTypeDefinition((TypeDefinitionHandle)parent);
            parentNamespace = typeDef.Namespace.IsNil ? "" : reader.GetString(typeDef.Namespace);
            parentName = reader.GetString(typeDef.Name);
        }

        if (parentNamespace == null || parentName == null)
            return;

        // Check if this is the target production method call
        if (parentNamespace == TargetTypeNamespace &&
            parentName == TargetTypeName &&
            memberName == TargetMethodName)
        {
            if (!allowDirectTargetCall)
                throw new InvalidOperationException("Target production method must use a direct non-generic call/callvirt MemberReference.");

            // A separately compiled friend probe necessarily encodes the two
            // internal parameter types as TypeRefs, while production encodes
            // them as TypeDefs. Raw blob equality is therefore not meaningful
            // across these images. Require the same restricted semantic shape
            // instead, with every probe parameter TypeRef bound to the exact
            // production AssemblyReference identity.
            if (!ValidateTargetSemanticSignature(
                    reader,
                    reader.GetBlobReader(memberRef.Signature),
                    SignatureTypeResolution.ProbeReference,
                    productionIdentity))
            {
                throw new InvalidOperationException("Probe target method semantic signature does not match the frozen target shape.");
            }

            // Exact scope binding: the only acceptable parent is a TypeReference
            // whose ResolutionScope is an AssemblyReference matching the exact
            // production assembly identity. TypeDefinition parents, ModuleReference
            // scopes, nested TypeReferences, nil scopes and any identity mismatch
            // all reject the probe.
            if (parentKind != HandleKind.TypeReference)
            {
                throw new InvalidOperationException(
                    $"Target method parent is not a TypeReference. Found: {parentKind}.");
            }
            TypeReference parentTypeRef = reader.GetTypeReference((TypeReferenceHandle)parent);
            if (parentTypeRef.ResolutionScope.Kind != HandleKind.AssemblyReference)
            {
                throw new InvalidOperationException(
                    $"Target method parent TypeReference resolution scope is not AssemblyReference. Found: {parentTypeRef.ResolutionScope.Kind}.");
            }
            AssemblyReference asmRef = reader.GetAssemblyReference((AssemblyReferenceHandle)parentTypeRef.ResolutionScope);
            VerifyAssemblyIdentity(asmRef, reader, productionIdentity);

            targetCallCount++;
            return;
        }

        // Check for reflection/dynamic invocation
        if (parentNamespace == "System" && parentName == "Type" &&
            (memberName == "GetType" || memberName == "GetMethod" ||
             memberName == "InvokeMember"))
        {
            reflectionAnchors.Add($"call:{parentName}.{memberName}");
            return;
        }

        // MethodBase.Invoke(object, object[])
        if (parentNamespace == "System.Reflection" && parentName == "MethodBase" &&
            memberName == "Invoke")
        {
            reflectionAnchors.Add($"call:{parentName}.{memberName}");
            return;
        }

        // Delegate reflection/dynamic dispatch.
        if (parentNamespace == "System" && parentName == "Delegate" &&
            (memberName == "CreateDelegate" || memberName == "DynamicInvoke"))
        {
            reflectionAnchors.Add($"call:{parentName}.{memberName}");
            return;
        }

        // Activator.CreateInstance
        if (parentNamespace == "System" && parentName == "Activator" &&
            memberName == "CreateInstance")
        {
            reflectionAnchors.Add($"call:{parentName}.{memberName}");
            return;
        }

        // Expression/Dynamic invocation
        if (parentNamespace == "System.Linq.Expressions" && parentName == "Expression" &&
            (memberName == "Lambda" || memberName == "Dynamic" || memberName == "Invoke"))
        {
            reflectionAnchors.Add($"call:{parentName}.{memberName}");
            return;
        }

        // Raw-world topology policy is enforced centrally by
        // CheckMetadataReferencesForForbiddenConstructs. Do not duplicate it
        // here: the probe is permitted to make the narrow readiness/identity
        // reads declared by that metadata allowlist.
    }

    private static void CheckMethodDefinition(
        MetadataReader reader,
        MethodDefinitionHandle methodDefHandle,
        List<string> reflectionAnchors,
        List<string> extractionAnchors)
    {
        MethodDefinition methodDef = reader.GetMethodDefinition(methodDefHandle);
        TypeDefinitionHandle declaringTypeHandle = methodDef.GetDeclaringType();
        if (declaringTypeHandle.IsNil) return;

        TypeDefinition declaringType = reader.GetTypeDefinition(declaringTypeHandle);
        string declaringName = reader.GetString(declaringType.Name);
        string methodName = reader.GetString(methodDef.Name);

        // Check for extraction anchor methods
        if (declaringName == "Game1NavigationWorldSource" ||
            declaringName == "NavigationOrdinaryWarpTopology")
        {
            extractionAnchors.Add($"call:{declaringName}.{methodName}");
        }
    }

    private static int PrintProductionMvid(string productionDllPath, TextWriter output, TextWriter error)
    {
        if (string.IsNullOrWhiteSpace(productionDllPath) || !Path.IsPathFullyQualified(productionDllPath) || !File.Exists(productionDllPath))
        {
            error.WriteLine("ERROR: production DLL must be an existing absolute path.");
            return 1;
        }

        try
        {
            byte[] productionBytes = ReadSnapshot(productionDllPath);
            using var productionPe = new PEReader(new MemoryStream(productionBytes, writable: false), PEStreamOptions.LeaveOpen);
            if (!productionPe.HasMetadata)
            {
                error.WriteLine("ERROR: Production assembly is not a managed PE.");
                return 1;
            }

            MetadataReader reader = productionPe.GetMetadataReader();
            AssemblyDefinition assembly = reader.GetAssemblyDefinition();
            if (reader.GetString(assembly.Name) != ExpectedProductionAssemblyName)
            {
                error.WriteLine($"ERROR: Production assembly name mismatch. Expected: {ExpectedProductionAssemblyName}.");
                return 1;
            }

            Guid mvid = reader.GetGuid(reader.GetModuleDefinition().Mvid);
            if (mvid == Guid.Empty)
            {
                error.WriteLine("ERROR: Production assembly MVID is empty.");
                return 1;
            }

            output.WriteLine(mvid.ToString("D").ToLowerInvariant());
            return 0;
        }
        catch (Exception exception) when (exception is BadImageFormatException or IOException or UnauthorizedAccessException or ArgumentException)
        {
            error.WriteLine("ERROR: Production assembly metadata could not be read.");
            return 1;
        }
    }

    /// <summary>
    /// Entry point. Usage: NavigationTopologyCharacterization.Contract
    /// --production-sha256 &lt;64 lowercase hex&gt; --production-dll &lt;absolute path&gt;
    /// --probe-dll &lt;absolute path&gt;, or --print-production-mvid --production-dll
    /// &lt;absolute path&gt;.
    /// </summary>
    internal static int Main(string[] arguments)
    {
        // Run self-test before argument validation so it exercises on every
        // invocation, including --help or misconfigured calls.
        {
            string? selfTestError = RunSelfTest();
            if (selfTestError != null)
            {
                Console.Error.WriteLine($"ERROR: Contract self-test failed: {selfTestError}");
                return 1;
            }
        }

        if (arguments.Length == 3 &&
            arguments[0] == "--print-production-mvid" &&
            arguments[1] == "--production-dll")
        {
            return PrintProductionMvid(arguments[2], Console.Out, Console.Error);
        }

        if (arguments.Length != 6 ||
            arguments[0] != "--production-sha256" ||
            arguments[2] != "--production-dll" ||
            arguments[4] != "--probe-dll")
        {
            Console.Error.WriteLine("Usage: NavigationTopologyCharacterization.Contract --production-sha256 <64 lowercase hex> --production-dll <absolute path> --probe-dll <absolute path>");
            return 2;
        }

        string expectedSha256 = arguments[1];
        string productionDllPath = arguments[3];
        string probeDllPath = arguments[5];

        return Validate(expectedSha256, productionDllPath, probeDllPath, Console.Error);
    }

    /// <summary>
    /// Self-test: verifies that the IL decoder rejects malformed input.
    /// Returns null on success, or an error message string on failure.
    /// </summary>
    private static unsafe string? RunSelfTest()
    {
        // Load the contract's own metadata for token resolution during self-test.
        string contractPath = typeof(NavigationTopologyCharacterizationContract).Assembly.Location;
        byte[] contractBytes = ReadSnapshot(contractPath);
        using var peReader = new PEReader(new MemoryStream(contractBytes, writable: false));
        MetadataReader reader = peReader.GetMetadataReader();

        // Test 1: Unknown opcode (0x24 is a reserved/unused ECMA-335 opcode)
        {
            byte[] bytes = new byte[] { 0x24 };
            fixed (byte* ptr = bytes)
            {
                var il = new BlobReader(ptr, bytes.Length);
                int count = 0;
                var refl = new List<string>();
                var extr = new List<string>();
                try
                {
                    ScanILBytes(il, reader, ref count, refl, extr, null, default);
                    return "Self-test failed: unknown/ reserved opcode 0x24 was not rejected.";
                }
                catch (InvalidOperationException) { /* expected */ }
            }
        }

        // Test 2: Valid opcode with insufficient operand bytes (call=0x28 needs 4 more bytes)
        {
            byte[] bytes = new byte[] { 0x28 };
            fixed (byte* ptr = bytes)
            {
                var il = new BlobReader(ptr, bytes.Length);
                int count = 0;
                var refl = new List<string>();
                var extr = new List<string>();
                try
                {
                    ScanILBytes(il, reader, ref count, refl, extr, null, default);
                    return "Self-test failed: insufficient bytes for call was not rejected.";
                }
                catch (InvalidOperationException) { /* expected */ }
            }
        }

        // Test 3: Trailing 0xFE prefix (no second byte follows)
        {
            byte[] bytes = new byte[] { 0xFE };
            fixed (byte* ptr = bytes)
            {
                var il = new BlobReader(ptr, bytes.Length);
                int count = 0;
                var refl = new List<string>();
                var extr = new List<string>();
                try
                {
                    ScanILBytes(il, reader, ref count, refl, extr, null, default);
                    return "Self-test failed: trailing 0xFE prefix was not rejected.";
                }
                catch (InvalidOperationException) { /* expected */ }
            }
        }

        // Test 4: Valid opcode sequence with insufficient InlineSwitch operand
        // (0x45 = switch, needs 4-byte count + count*4 bytes)
        {
            byte[] bytes = new byte[] { 0x45, 0x00, 0x00, 0x00, 0x05 }; // count=5, but only 0 bytes follow
            fixed (byte* ptr = bytes)
            {
                var il = new BlobReader(ptr, bytes.Length);
                int count = 0;
                var refl = new List<string>();
                var extr = new List<string>();
                try
                {
                    ScanILBytes(il, reader, ref count, refl, extr, null, default);
                    return "Self-test failed: insufficient InlineSwitch targets was not rejected.";
                }
                catch (InvalidOperationException) { /* expected */ }
            }
        }

        // Test 5: Negative InlineSwitch count must reject before size arithmetic.
        {
            byte[] bytes = new byte[] { 0x45, 0xFF, 0xFF, 0xFF, 0xFF };
            fixed (byte* ptr = bytes)
            {
                var il = new BlobReader(ptr, bytes.Length);
                int count = 0;
                var refl = new List<string>();
                var extr = new List<string>();
                try
                {
                    ScanILBytes(il, reader, ref count, refl, extr, null, default);
                    return "Self-test failed: negative InlineSwitch count was not rejected.";
                }
                catch (InvalidOperationException) { /* expected */ }
            }
        }

        // Test 6: calli must reject rather than skip an indirect signature token.
        {
            byte[] bytes = new byte[] { 0x29, 0x00, 0x00, 0x00, 0x00 };
            fixed (byte* ptr = bytes)
            {
                var il = new BlobReader(ptr, bytes.Length);
                int count = 0;
                var refl = new List<string>();
                var extr = new List<string>();
                try
                {
                    ScanILBytes(il, reader, ref count, refl, extr, null, default);
                    return "Self-test failed: calli was not rejected.";
                }
                catch (InvalidOperationException) { /* expected */ }
            }
        }

        // Test 7: Valid opcode sequence with correct bytes succeeds.
        // Includes the compiler-emitted two-byte constrained. prefix with its
        // InlineType operand, followed by ret.
        {
            byte[] bytes = new byte[] { 0xFE, 0x16, 0x01, 0x00, 0x00, 0x01, 0x2A };
            fixed (byte* ptr = bytes)
            {
                var il = new BlobReader(ptr, bytes.Length);
                int count = 0;
                var refl = new List<string>();
                var extr = new List<string>();
                try
                {
                    ScanILBytes(il, reader, ref count, refl, extr, null, default);
                    // No exception is expected
                }
                catch (Exception ex)
                {
                    return $"Self-test failed: valid ret opcode was rejected: {ex.GetType().Name}: {ex.Message}";
                }
            }
        }

        return null; // all tests passed
    }
}