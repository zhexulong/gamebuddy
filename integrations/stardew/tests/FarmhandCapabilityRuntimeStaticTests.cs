using System.Buffers.Binary;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

internal static class FarmhandCapabilityRuntimeStaticTests
{
    private const string AssemblyPathEnvironmentVariable = "GAMEBUDDY_STARDEW_ASSEMBLY";
    private const string Namespace = "GameBuddy.Stardew";

    internal static void Run()
    {
        string assemblyPath = RequireProductionAssemblyPath();
        using FileStream stream = File.OpenRead(assemblyPath);
        using PEReader peReader = new(stream);
        MetadataReader reader = peReader.GetMetadataReader();

        TypeDefinitionHandle executionManager = FindType(reader, "ExecutionManager");
        TypeDefinitionHandle bridgeSession = FindType(reader, "BridgeSession");
        TypeDefinitionHandle modEntry = FindType(reader, "ModEntry");

        AssertConstructor(reader, executionManager, "ExecutionManager", 4, 1);
        AssertExecutionManagerDoesNotDeclareLegacyCapabilityProjections(reader, executionManager);
        AssertOnlyZeroArgumentPublicMethod(reader, executionManager, "CreateBridgeSnapshot");
        AssertConstructor(reader, bridgeSession, "BridgeSession", 5, 3);
        AssertBridgeSessionPresentationLocaleParameter(reader, bridgeSession);
        AssertModEntryUsesOneCapabilitySurface(reader, peReader, modEntry, executionManager, bridgeSession);
    }

    private static void AssertConstructor(MetadataReader reader, TypeDefinitionHandle typeHandle, string typeName, int parameterCount, int capabilityParameterIndex)
    {
        TypeDefinition type = reader.GetTypeDefinition(typeHandle);
        MethodDefinitionHandle[] constructors = type.GetMethods()
            .Where(handle => reader.GetString(reader.GetMethodDefinition(handle).Name) == ".ctor")
            .ToArray();
        Assert(constructors.Length == 1, $"{typeName} must expose exactly one instance constructor; found {constructors.Length}.");

        string[] parameters = ReadMethodParameterTypes(reader, reader.GetMethodDefinition(constructors[0]).Signature);
        Assert(parameters.Length == parameterCount,
            $"{typeName} constructor must have {parameterCount} parameters; found {parameters.Length} ({string.Join(", ", parameters)}).");
        Assert(parameters[capabilityParameterIndex] == $"{Namespace}.FarmhandCapabilitySurface",
            $"{typeName} constructor parameter {capabilityParameterIndex + 1} must be FarmhandCapabilitySurface; found {parameters[capabilityParameterIndex]}.");
        Assert(!parameters.Any(parameter => parameter.Contains("IReadOnlySet", StringComparison.Ordinal)),
            $"{typeName} must not retain an IReadOnlySet capability constructor.");
    }

    private static void AssertBridgeSessionPresentationLocaleParameter(MetadataReader reader, TypeDefinitionHandle typeHandle)
    {
        MethodDefinition constructor = reader.GetTypeDefinition(typeHandle).GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single(method => reader.GetString(method.Name) == ".ctor");
        string[] parameters = ReadMethodParameterTypes(reader, constructor.Signature);
        Assert(parameters[4] == "System.Func`1<string>",
            $"BridgeSession constructor parameter 5 must be the presentation-locale provider; found {parameters[4]}.");
    }

    private static void AssertExecutionManagerDoesNotDeclareLegacyCapabilityProjections(MetadataReader reader, TypeDefinitionHandle typeHandle)
    {
        string[] forbiddenMethods = reader.GetTypeDefinition(typeHandle).GetMethods()
            .Select(reader.GetMethodDefinition)
            .Select(method => reader.GetString(method.Name))
            .Where(name => name is "CreateCapabilities" or "HasCapability")
            .ToArray();
        Assert(forbiddenMethods.Length == 0,
            $"Compiled ExecutionManager must declare neither CreateCapabilities nor HasCapability; found {string.Join(", ", forbiddenMethods)}.");
    }

    private static void AssertOnlyZeroArgumentPublicMethod(MetadataReader reader, TypeDefinitionHandle typeHandle, string methodName)
    {
        MethodDefinitionHandle[] publicMethods = reader.GetTypeDefinition(typeHandle).GetMethods()
            .Where(handle =>
            {
                MethodDefinition method = reader.GetMethodDefinition(handle);
                return reader.GetString(method.Name) == methodName && (method.Attributes & MethodAttributes.Public) != 0;
            })
            .ToArray();
        Assert(publicMethods.Length == 1, $"ExecutionManager must expose exactly one public {methodName} method; found {publicMethods.Length}.");
        string[] parameters = ReadMethodParameterTypes(reader, reader.GetMethodDefinition(publicMethods[0]).Signature);
        Assert(parameters.Length == 0, $"ExecutionManager.{methodName} must be zero-argument; found {parameters.Length} parameters.");
    }

    private static void AssertModEntryUsesOneCapabilitySurface(
        MetadataReader reader,
        PEReader peReader,
        TypeDefinitionHandle modEntry,
        TypeDefinitionHandle executionManager,
        TypeDefinitionHandle bridgeSession)
    {
        MethodDefinitionHandle methodHandle = reader.GetTypeDefinition(modEntry).GetMethods()
            .Single(handle => reader.GetString(reader.GetMethodDefinition(handle).Name) == "TryInitializeEmbodiment");
        MethodDefinition method = reader.GetMethodDefinition(methodHandle);
        Assert(method.RelativeVirtualAddress != 0, "Compiled ModEntry.TryInitializeEmbodiment must have an IL body.");
        MethodBodyBlock body = peReader.GetMethodBody(method.RelativeVirtualAddress);
        if (body.GetILBytes() is not { } il)
            throw new InvalidOperationException("Compiled ModEntry.TryInitializeEmbodiment method body has no IL.");
        Assert(il.Length > 0, "Compiled ModEntry.TryInitializeEmbodiment method body has empty IL.");
        IReadOnlyList<IlInstruction> instructions = ReadInstructions(il.ToArray());

        IlInstruction[] producers = instructions.Where(instruction =>
            instruction.OpCode is var opcode && (opcode == OpCodes.Call || opcode == OpCodes.Callvirt)
            && IsCapabilitySurfaceProducer(reader, instruction.Target)).ToArray();
        Assert(producers.Length == 1,
            $"Compiled ModEntry.TryInitializeEmbodiment must call ModConfig.CreateFarmhandCapabilitySurface exactly once; found {producers.Length}.");

        int producerIndex = Enumerable.Range(0, instructions.Count).Single(index => instructions[index] == producers[0]);
        Assert(producerIndex + 1 < instructions.Count, "CreateFarmhandCapabilitySurface result must be stored immediately in one local.");
        Assert(TryGetStoredLocal(instructions[producerIndex + 1], out int capabilityLocal),
            "CreateFarmhandCapabilitySurface result must be stored immediately in one local.");

        HashSet<string> requiredTypes = new(StringComparer.Ordinal)
        {
            GetFullTypeName(reader, executionManager),
            GetFullTypeName(reader, bridgeSession),
        };
        HashSet<string> verifiedTypes = new(StringComparer.Ordinal);
        VerifyCapabilityLocalDataflow(reader, instructions, capabilityLocal, requiredTypes, verifiedTypes);
        Assert(verifiedTypes.SetEquals(requiredTypes),
            "The exact CreateFarmhandCapabilitySurface local must be supplied to both ExecutionManager and BridgeSession constructors.");
    }

    private static void VerifyCapabilityLocalDataflow(
        MetadataReader reader,
        IReadOnlyList<IlInstruction> instructions,
        int capabilityLocal,
        HashSet<string> requiredTypes,
        HashSet<string> verifiedTypes)
    {
        List<StackValue> stack = new();
        for (int index = 0; index < instructions.Count; index++)
        {
            IlInstruction instruction = instructions[index];
            if (TryGetLoadedLocal(instruction, out int loadedLocal))
            {
                stack.Add(loadedLocal == capabilityLocal ? StackValue.CapabilityLocal : StackValue.Unknown);
                continue;
            }
            if (TryGetStoredLocal(instruction, out int storedLocal))
            {
                StackValue value = Pop(stack, 1, instruction)[0];
                Assert(storedLocal != capabilityLocal || value == StackValue.CapabilityFactoryResult,
                    "The capability-surface local must only receive CreateFarmhandCapabilitySurface's result.");
                continue;
            }
            if (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt || instruction.OpCode == OpCodes.Newobj)
            {
                int parameterCount = GetMethodParameterCount(reader, instruction.Target);
                bool isConstructor = instruction.OpCode == OpCodes.Newobj;
                int popCount = parameterCount + (isConstructor || IsStaticMethod(reader, instruction.Target) ? 0 : 1);
                StackValue[] arguments = Pop(stack, popCount, instruction);
                if (isConstructor && GetConstructedType(reader, instruction.Target) is string constructedType && requiredTypes.Contains(constructedType))
                {
                    int capabilityParameterIndex = constructedType.EndsWith(".ExecutionManager", StringComparison.Ordinal) ? 1 : 3;
                    Assert(arguments[capabilityParameterIndex] == StackValue.CapabilityLocal,
                        $"{constructedType} must receive the exact local produced by CreateFarmhandCapabilitySurface.");
                    verifiedTypes.Add(constructedType);
                }
                if (isConstructor || !ReturnsVoid(reader, instruction.Target))
                    stack.Add(IsCapabilitySurfaceProducer(reader, instruction.Target) ? StackValue.CapabilityFactoryResult : StackValue.Unknown);
                continue;
            }

            ApplyOrdinaryStackEffect(stack, instruction);
        }
    }

    private static StackValue[] Pop(List<StackValue> stack, int count, IlInstruction instruction)
    {
        Assert(stack.Count >= count, $"IL stack underflow at offset 0x{instruction.Offset:X4} ({instruction.OpCode.Name}).");
        StackValue[] values = stack.Skip(stack.Count - count).ToArray();
        stack.RemoveRange(stack.Count - count, count);
        return values;
    }

    private static void ApplyOrdinaryStackEffect(List<StackValue> stack, IlInstruction instruction)
    {
        if (instruction.OpCode == OpCodes.Ret)
        {
            stack.Clear();
            return;
        }
        if (instruction.OpCode == OpCodes.Dup)
        {
            Assert(stack.Count > 0, $"IL stack underflow at offset 0x{instruction.Offset:X4} (dup).");
            stack.Add(stack[^1]);
            return;
        }
        int popCount = GetFixedStackPopCount(instruction.OpCode.StackBehaviourPop, instruction);
        _ = Pop(stack, popCount, instruction);
        int pushCount = GetFixedStackPushCount(instruction.OpCode.StackBehaviourPush, instruction);
        for (int count = 0; count < pushCount; count++)
            stack.Add(StackValue.Unknown);
    }

    private static int GetFixedStackPopCount(StackBehaviour behaviour, IlInstruction instruction) => behaviour switch
    {
        StackBehaviour.Pop0 => 0,
        StackBehaviour.Pop1 or StackBehaviour.Popi or StackBehaviour.Popref => 1,
        StackBehaviour.Pop1_pop1 or StackBehaviour.Popi_pop1 or StackBehaviour.Popi_popi or StackBehaviour.Popi_popi8
            or StackBehaviour.Popi_popr4 or StackBehaviour.Popi_popr8 or StackBehaviour.Popref_pop1 or StackBehaviour.Popref_popi => 2,
        StackBehaviour.Popi_popi_popi or StackBehaviour.Popref_popi_popi or StackBehaviour.Popref_popi_popi8
            or StackBehaviour.Popref_popi_popr4 or StackBehaviour.Popref_popi_popr8 or StackBehaviour.Popref_popi_popref => 3,
        StackBehaviour.Varpop => throw new InvalidOperationException($"Unsupported variable-pop IL opcode at 0x{instruction.Offset:X4}: {instruction.OpCode.Name}."),
        _ => throw new InvalidOperationException($"Unsupported IL stack-pop behavior at 0x{instruction.Offset:X4}: {behaviour}."),
    };

    private static int GetFixedStackPushCount(StackBehaviour behaviour, IlInstruction instruction) => behaviour switch
    {
        StackBehaviour.Push0 => 0,
        StackBehaviour.Push1 or StackBehaviour.Pushi or StackBehaviour.Pushi8 or StackBehaviour.Pushr4 or StackBehaviour.Pushr8 or StackBehaviour.Pushref => 1,
        StackBehaviour.Push1_push1 => 2,
        StackBehaviour.Varpush => throw new InvalidOperationException($"Unsupported variable-push IL opcode at 0x{instruction.Offset:X4}: {instruction.OpCode.Name}."),
        _ => throw new InvalidOperationException($"Unsupported IL stack-push behavior at 0x{instruction.Offset:X4}: {behaviour}."),
    };

    private static bool IsCapabilitySurfaceProducer(MetadataReader reader, EntityHandle target) =>
        GetMethodName(reader, target) == "CreateFarmhandCapabilitySurface"
        && GetConstructedType(reader, target) == $"{Namespace}.ModConfig";

    private static EntityHandle ResolveMethodSpecification(MetadataReader reader, EntityHandle method) => method.Kind == HandleKind.MethodSpecification
        ? reader.GetMethodSpecification((MethodSpecificationHandle)method).Method
        : method;

    private static string GetMethodName(MetadataReader reader, EntityHandle method) => ResolveMethodSpecification(reader, method).Kind switch
    {
        HandleKind.MethodDefinition => reader.GetString(reader.GetMethodDefinition((MethodDefinitionHandle)ResolveMethodSpecification(reader, method)).Name),
        HandleKind.MemberReference => reader.GetString(reader.GetMemberReference((MemberReferenceHandle)ResolveMethodSpecification(reader, method)).Name),
        _ => string.Empty,
    };

    private static int GetMethodParameterCount(MetadataReader reader, EntityHandle method) => ResolveMethodSpecification(reader, method).Kind switch
    {
        HandleKind.MethodDefinition => ReadMethodParameterTypes(reader, reader.GetMethodDefinition((MethodDefinitionHandle)ResolveMethodSpecification(reader, method)).Signature).Length,
        HandleKind.MemberReference => ReadMethodParameterTypes(reader, reader.GetMemberReference((MemberReferenceHandle)ResolveMethodSpecification(reader, method)).Signature).Length,
        _ => throw new InvalidOperationException($"Unsupported method token kind: {method.Kind}."),
    };

    private static bool ReturnsVoid(MetadataReader reader, EntityHandle method) => ResolveMethodSpecification(reader, method).Kind switch
    {
        HandleKind.MethodDefinition => ReadMethodReturnType(reader, reader.GetMethodDefinition((MethodDefinitionHandle)ResolveMethodSpecification(reader, method)).Signature) == "void",
        HandleKind.MemberReference => ReadMethodReturnType(reader, reader.GetMemberReference((MemberReferenceHandle)ResolveMethodSpecification(reader, method)).Signature) == "void",
        _ => throw new InvalidOperationException($"Unsupported method token kind: {method.Kind}."),
    };

    private static string ReadMethodReturnType(MetadataReader reader, BlobHandle signature)
    {
        BlobReader blob = reader.GetBlobReader(signature);
        byte callingConvention = blob.ReadByte();
        if ((callingConvention & 0x10) != 0)
            _ = blob.ReadCompressedInteger();
        _ = blob.ReadCompressedInteger();
        return ReadType(reader, ref blob);
    }

    private static bool IsStaticMethod(MetadataReader reader, EntityHandle method) => ResolveMethodSpecification(reader, method).Kind switch
    {
        HandleKind.MethodDefinition => (reader.GetMethodDefinition((MethodDefinitionHandle)ResolveMethodSpecification(reader, method)).Attributes & MethodAttributes.Static) != 0,
        HandleKind.MemberReference => (reader.GetMemberReference((MemberReferenceHandle)ResolveMethodSpecification(reader, method)).Signature.IsNil ? false : IsStaticSignature(reader, reader.GetMemberReference((MemberReferenceHandle)ResolveMethodSpecification(reader, method)).Signature)),
        _ => throw new InvalidOperationException($"Unsupported method token kind: {method.Kind}."),
    };

    private static bool IsStaticSignature(MetadataReader reader, BlobHandle signature)
    {
        BlobReader blob = reader.GetBlobReader(signature);
        return (blob.ReadByte() & 0x20) != 0;
    }

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
                ? operandSize switch { sizeof(byte) => il[operandOffset], sizeof(short) => BinaryPrimitives.ReadUInt16LittleEndian(il.AsSpan(operandOffset, sizeof(short))), _ => BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(operandOffset, sizeof(int))) }
                : 0;
            EntityHandle target = opcode.OperandType is OperandType.InlineMethod
                ? MetadataTokens.EntityHandle(operand)
                : default;
            instructions.Add(new(instructionOffset, opcode, operand, target));
            offset += operandSize;
        }
        return instructions;
    }

    private static bool TryGetLoadedLocal(IlInstruction instruction, out int local) => TryGetLocal(instruction.OpCode, instruction.Operand, "ldloc", out local);

    private static bool TryGetStoredLocal(IlInstruction instruction, out int local) => TryGetLocal(instruction.OpCode, instruction.Operand, "stloc", out local);

    private static bool TryGetLocal(OpCode opcode, int operand, string operation, out int local)
    {
        string name = opcode.Name ?? string.Empty;
        if (name == operation || name == operation + ".s")
        {
            local = operand;
            return true;
        }
        if (name.StartsWith(operation + ".", StringComparison.Ordinal) && int.TryParse(name[(operation.Length + 1)..], out local))
            return true;
        local = default;
        return false;
    }

    private readonly record struct IlInstruction(int Offset, OpCode OpCode, int Operand, EntityHandle Target);

    private enum StackValue { Unknown, CapabilityFactoryResult, CapabilityLocal }

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

    private static string? GetConstructedType(MetadataReader reader, EntityHandle constructor)
    {
        EntityHandle resolvedConstructor = ResolveMethodSpecification(reader, constructor);
        return resolvedConstructor.Kind switch
        {
            HandleKind.MethodDefinition => GetFullTypeName(reader, reader.GetMethodDefinition((MethodDefinitionHandle)resolvedConstructor).GetDeclaringType()),
            HandleKind.MemberReference => GetMemberReferenceParentType(reader, reader.GetMemberReference((MemberReferenceHandle)resolvedConstructor).Parent),
            _ => null,
        };
    }

    private static string? GetMemberReferenceParentType(MetadataReader reader, EntityHandle parent) => parent.Kind switch
    {
        HandleKind.TypeDefinition => GetFullTypeName(reader, (TypeDefinitionHandle)parent),
        HandleKind.TypeReference => GetFullTypeName(reader, (TypeReferenceHandle)parent),
        _ => null,
    };

    private static TypeDefinitionHandle FindType(MetadataReader reader, string name)
    {
        foreach (TypeDefinitionHandle handle in reader.TypeDefinitions)
        {
            TypeDefinition type = reader.GetTypeDefinition(handle);
            if (reader.GetString(type.Namespace) == Namespace && reader.GetString(type.Name) == name)
                return handle;
        }
        throw new InvalidOperationException($"Compiled production assembly does not define {Namespace}.{name}.");
    }

    private static string[] ReadMethodParameterTypes(MetadataReader reader, BlobHandle signature)
    {
        BlobReader blob = reader.GetBlobReader(signature);
        byte callingConvention = blob.ReadByte();
        if ((callingConvention & 0x10) != 0)
            _ = blob.ReadCompressedInteger();
        int parameterCount = blob.ReadCompressedInteger();
        _ = ReadType(reader, ref blob); // return type
        string[] parameters = new string[parameterCount];
        for (int index = 0; index < parameters.Length; index++)
            parameters[index] = ReadType(reader, ref blob);
        return parameters;
    }

    private static string ReadType(MetadataReader reader, ref BlobReader blob)
    {
        byte elementType = blob.ReadByte();
        while (elementType is 0x1F or 0x20) // required/optional custom modifier
        {
            _ = ReadTypeDefOrRef(reader, blob.ReadCompressedInteger());
            elementType = blob.ReadByte();
        }
        return elementType switch
        {
            0x01 => "void",
            0x02 => "bool",
            0x03 => "char",
            0x04 => "sbyte",
            0x05 => "byte",
            0x06 => "short",
            0x07 => "ushort",
            0x08 => "int",
            0x09 => "uint",
            0x0A => "long",
            0x0B => "ulong",
            0x0C => "float",
            0x0D => "double",
            0x18 => "nativeint",
            0x19 => "nativeuint",
            0x0E => "string",
            0x1C => "object",
            0x10 => ReadType(reader, ref blob) + "&",
            0x0F => ReadType(reader, ref blob) + "*",
            0x11 or 0x12 => ReadTypeDefOrRef(reader, blob.ReadCompressedInteger()),
            0x13 => "!" + blob.ReadCompressedInteger(),
            0x14 => ReadType(reader, ref blob) + "[]",
            0x15 => ReadGenericInstance(reader, ref blob),
            0x1D => ReadType(reader, ref blob) + "[]",
            0x1E => "!!" + blob.ReadCompressedInteger(),
            _ => throw new InvalidOperationException($"Unsupported metadata signature element type 0x{elementType:X2}."),
        };
    }

    private static string ReadGenericInstance(MetadataReader reader, ref BlobReader blob)
    {
        byte classOrValueType = blob.ReadByte();
        if (classOrValueType is not (0x11 or 0x12))
            throw new InvalidOperationException("Generic instance must identify a class or value type.");
        string genericType = ReadTypeDefOrRef(reader, blob.ReadCompressedInteger());
        int argumentCount = blob.ReadCompressedInteger();
        string[] arguments = new string[argumentCount];
        for (int index = 0; index < arguments.Length; index++)
            arguments[index] = ReadType(reader, ref blob);
        return $"{genericType}<{string.Join(",", arguments)}>";
    }

    private static string ReadTypeDefOrRef(MetadataReader reader, int codedIndex)
    {
        int rowId = codedIndex >> 2;
        return (codedIndex & 3) switch
        {
            0 => GetFullTypeName(reader, MetadataTokens.TypeDefinitionHandle(rowId)),
            1 => GetFullTypeName(reader, MetadataTokens.TypeReferenceHandle(rowId)),
            2 => $"TypeSpec({rowId})",
            _ => throw new InvalidOperationException("Invalid TypeDefOrRef metadata token."),
        };
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

    private static string RequireProductionAssemblyPath()
    {
        string? suppliedPath = Environment.GetEnvironmentVariable(AssemblyPathEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(suppliedPath))
            throw new InvalidOperationException($"Missing production assembly path. Pass exactly one DLL argument or set {AssemblyPathEnvironmentVariable}.");

        string fullPath = Path.GetFullPath(suppliedPath);
        if (!File.Exists(fullPath))
            throw new InvalidOperationException($"{AssemblyPathEnvironmentVariable} does not name an existing production assembly: {fullPath}");
        return fullPath;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
