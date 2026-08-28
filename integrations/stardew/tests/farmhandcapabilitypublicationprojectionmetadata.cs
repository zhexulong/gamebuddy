using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

/// <summary>
/// Metadata-only verifier for the compiled Stardew Mod/Core capability boundary.
/// It deliberately never loads a production assembly or constructs a production
/// authority; all facts come from the exact SHA-checked PE bytes supplied by the
/// contract entry point.
/// </summary>
internal static class FarmhandCapabilityPublicationProjectionMetadata
{
    private const string ModAssemblyName = "GameBuddy.Stardew";
    private const string CoreAssemblyName = "GameBuddy.Stardew.Core";
    private const string PublicationType = "GameBuddy.Stardew.Core.Policy.FarmhandCapabilityPublication";
    private const string CapabilitySetType = "GameBuddy.Stardew.Core.Policy.FarmhandCapabilitySet";
    private const string OperationKindType = "GameBuddy.Stardew.Core.Policy.FarmhandOperationKind";
    private const string CatalogType = "GameBuddy.Stardew.Core.Policy.FarmhandActionCatalog";
    private const string ProviderType = "System.Func<GameBuddy.Stardew.Core.Policy.FarmhandCapabilityPublication>";
    private const string ScreenStateType = "GameBuddy.Stardew.ModEntry+ScreenEmbodimentState";
    private const string ExecutionControllerType = "GameBuddy.Stardew.ExecutionManager";
    private const string BridgeSessionType = "GameBuddy.Stardew.BridgeSession";

    internal static void AssertComposition(byte[] modBytes, byte[] coreBytes)
    {
        using ArtifactMetadata mod = new(modBytes, ModAssemblyName);
        using ArtifactMetadata core = new(coreBytes, CoreAssemblyName);

        AssertModComposition(mod);
        AssertCoreComposition(core);
        AssertProviderProjection(mod);
    }

    private static void AssertModComposition(ArtifactMetadata mod)
    {
        TypeDefinitionHandle modEntry = mod.RequireType("GameBuddy.Stardew.ModEntry");
        MethodDefinitionHandle initialize = mod.RequireMethod(modEntry, "TryInitializeEmbodiment");
        IReadOnlyList<Instruction> initializeInstructions = mod.ReadInstructions(initialize);
        IReadOnlyList<MethodTarget> initializeCalls = mod.MethodTargets(initializeInstructions);

        RequireOrdered(
            initializeCalls,
            ("GameBuddy.Stardew.ModConfig", "get_EnabledActionSet"),
            (PublicationType, "Initial"),
            "ModEntry initialization must derive publication from ModConfig before constructing capability consumers");

        ConstructionSite executionConstruction = RequireProviderConstruction(
            mod,
            initializeInstructions,
            ExecutionControllerType,
            "ModEntry execution construction must use the publication-provider constructor");
        ConstructionSite bridgeConstruction = RequireProviderConstruction(
            mod,
            initializeInstructions,
            BridgeSessionType,
            "ModEntry bridge construction must use the publication-provider constructor");
        int publicationSetterIndex = IndexOfCall(
            initializeInstructions,
            initializeCalls,
            ScreenStateType,
            "set_CapabilityPublication");
        if (publicationSetterIndex >= executionConstruction.InstructionIndex)
            Fail("ModEntry must publish the initial capability before constructing either capability consumer.");

        ProviderDelegateBinding executionProvider = RequireProviderDelegate(
            mod,
            initializeInstructions,
            executionConstruction,
            "ExecutionManager");
        ProviderDelegateBinding bridgeProvider = RequireProviderDelegate(
            mod,
            initializeInstructions,
            bridgeConstruction,
            "BridgeSession");
        RequireSharedCapabilityState(executionProvider, bridgeProvider);
        RequireAbsent(
            initializeCalls,
            new[]
            {
                (PublicationType, "WithEnabledActions"),
                (CapabilitySetType, "FromPolicyEnabledOperations"),
            },
            "ModEntry initialization must not create a second publication/set authority");

        List<MethodTarget> providerMethods = initializeInstructions
            .Where(instruction => instruction.OpCode == OpCodes.Ldftn)
            .Select(instruction => mod.TryResolveMethodTarget(instruction.Token))
            .Where(target => target is not null)
            .Cast<MethodTarget>()
            .ToList();
        if (providerMethods.Count == 0)
            Fail("ModEntry initialization has no compiled capability provider closure.");

        int providerClosures = 0;
        foreach (MethodTarget provider in providerMethods)
        {
            if (provider.MethodDefinition is not MethodDefinitionHandle providerHandle)
                continue;
            IReadOnlyList<MethodTarget> targets = mod.MethodTargets(mod.ReadInstructions(providerHandle));
            if (targets.Any(target => target.Owner.EndsWith("ScreenEmbodimentState", StringComparison.Ordinal)
                && target.Name == "get_CapabilityPublication"))
                providerClosures++;
        }

        if (providerClosures == 0)
            Fail("ModEntry capability consumers are not backed by a closure that reads ScreenEmbodimentState.CapabilityPublication.");

        MethodDefinitionHandle refresh = mod.RequireMethod(modEntry, "RefreshFarmhandCapabilityPublication");
        IReadOnlyList<Instruction> refreshInstructions = mod.ReadInstructions(refresh);
        IReadOnlyList<MethodTarget> refreshCalls = mod.MethodTargets(refreshInstructions);
        RequireOrdered(
            refreshCalls,
            ("GameBuddy.Stardew.ModConfig", "get_HasValidActionPolicy"),
            ("GameBuddy.Stardew.ModConfig", "get_EnabledActionSet"),
            (PublicationType, "WithEnabledActions"),
            ("GameBuddy.Stardew.BridgeSession", "TryCreateCatalogUpdate"),
            ("GameBuddy.Stardew.LocalPipeBridge", "TryEnqueueOutbound"),
            "capability refresh must validate policy, derive a successor, and publish only through the existing bridge");
        RequireAbsent(
            refreshCalls,
            new[]
            {
                (PublicationType, "Initial"),
                (CapabilitySetType, "FromPolicyEnabledOperations"),
            },
            "capability refresh must not mint an independent initial/set authority");
        if (!refreshInstructions.Any(instruction => instruction.OpCode == OpCodes.Ceq))
            Fail("refresh does not compare the derived publication with the current immutable publication.");
        AssertFailClosedPolicyGuard(refreshInstructions, refreshCalls);
    }

    private static ConstructionSite RequireProviderConstruction(
        ArtifactMetadata mod,
        IReadOnlyList<Instruction> instructions,
        string owner,
        string message)
    {
        List<ConstructionSite> sites = new();
        for (int instructionIndex = 0; instructionIndex < instructions.Count; instructionIndex++)
        {
            Instruction instruction = instructions[instructionIndex];
            if (instruction.OpCode != OpCodes.Newobj)
                continue;

            MethodTarget? target = mod.TryResolveMethodTarget(instruction.Token, instruction.Offset, instruction.OpCode);
            if (target is null || target.Owner != owner || target.Name != ".ctor")
                continue;
            sites.Add(new ConstructionSite(instructionIndex, instruction, target));
        }

        if (sites.Count != 1)
        {
            string observed = string.Join(", ", sites.Select(site =>
                $"offset 0x{site.Instruction.Offset:X4}: {FormatSignature(site.Constructor.Signature)}"));
            Fail($"{message} must have exactly one actual newobj path; found {sites.Count}. Observed: {observed}");
        }

        ConstructionSite site = sites[0];
        int providerParameterIndex = RequireExactPublicationProviderConstructor(
            site.Constructor.Signature,
            message);
        return site with { ProviderParameterIndex = providerParameterIndex };
    }

    private static int RequireExactPublicationProviderConstructor(
        MethodSignature<string>? signature,
        string message)
    {
        if (signature is not MethodSignature<string> resolvedSignature)
        {
            Fail($"{message} uses an unresolved constructor signature.");
            return -1;
        }

        int[] providerParameterIndexes = resolvedSignature.ParameterTypes
            .Select((parameter, index) => (parameter, index))
            .Where(item => IsPublicationProviderParameter(item.parameter))
            .Select(item => item.index)
            .ToArray();
        if (providerParameterIndexes.Length != 1)
            Fail(
                $"{message} must resolve to exactly one authority-bearing "
                + $"{ProviderType} parameter; found {providerParameterIndexes.Length}. "
                + $"Observed: {FormatSignature(resolvedSignature)}.");

        foreach (string parameter in resolvedSignature.ParameterTypes)
        {
            if (!IsPublicationProviderParameter(parameter) && IsCapabilityAuthorityParameter(parameter))
                Fail(
                    $"{message} contains an additional capability/publication authority parameter "
                    + $"{parameter}; observed signature: {FormatSignature(resolvedSignature)}.");
        }

        return providerParameterIndexes[0];
    }

    private static MethodSignature<string> RequireResolvedSignature(MethodTarget target, string label)
    {
        if (target.Signature is not MethodSignature<string> signature)
        {
            Fail($"{label} has an unresolved constructor signature.");
            return default;
        }

        return signature;
    }

    private static ProviderDelegateBinding RequireProviderDelegate(
        ArtifactMetadata mod,
        IReadOnlyList<Instruction> instructions,
        ConstructionSite construction,
        string consumerLabel)
    {
        if (construction.Constructor.Signature is not MethodSignature<string> constructorSignature)
        {
            Fail($"{consumerLabel} construction has no resolved constructor signature.");
            return null!;
        }

        IReadOnlyList<ArgumentExpression> arguments = TraceConstructorArguments(
            mod,
            instructions,
            construction.InstructionIndex,
            constructorSignature,
            consumerLabel,
            construction.ProviderParameterIndex);
        ArgumentExpression providerArgument = arguments[construction.ProviderParameterIndex];
        if (providerArgument.ProducerInstructionIndex < 0
            || providerArgument.ProducerInstructionIndex != providerArgument.EndExclusive - 1)
        {
            Fail(
                $"{consumerLabel} capability provider argument is not an immediate delegate construction "
                + "directly feeding the consumer newobj.");
        }

        Instruction delegateInstruction = instructions[providerArgument.ProducerInstructionIndex];
        if (delegateInstruction.OpCode != OpCodes.Newobj)
            Fail($"{consumerLabel} capability provider argument does not end in a Func delegate newobj.");

        MethodTarget? delegateConstructor = mod.TryResolveMethodTarget(
            delegateInstruction.Token,
            delegateInstruction.Offset,
            delegateInstruction.OpCode);
        if (delegateConstructor is null || !IsPublicationProviderDelegateConstructor(delegateConstructor))
            Fail(
                $"{consumerLabel} capability provider argument does not construct the exact "
                + $"{ProviderType} delegate directly before the consumer newobj.");

        List<MethodTarget> delegatePreparations = providerArgument.Instructions
            .Where(instruction => instruction.OpCode == OpCodes.Newobj)
            .Select(instruction => mod.TryResolveMethodTarget(instruction.Token, instruction.Offset, instruction.OpCode))
            .Where(target => target is not null && IsPublicationProviderDelegateConstructor(target))
            .Cast<MethodTarget>()
            .ToList();
        if (delegatePreparations.Count != 1)
            Fail(
                $"{consumerLabel} capability provider argument has an ambiguous Func delegate preparation "
                + $"chain; found {delegatePreparations.Count} exact delegate constructions.");

        IReadOnlyList<ArgumentExpression> delegateArguments = TraceConstructorArguments(
            mod,
            instructions,
            providerArgument.ProducerInstructionIndex,
            RequireResolvedSignature(delegateConstructor!, $"{consumerLabel} publication provider delegate"),
            $"{consumerLabel} publication provider delegate",
            strictParameterIndex: 1);
        if (delegateArguments.Count != 2)
            Fail($"{consumerLabel} publication provider delegate has an unexpected constructor argument count.");

        ArgumentExpression callbackArgument = delegateArguments[1];
        if (callbackArgument.ProducerInstructionIndex < 0
            || callbackArgument.ProducerInstructionIndex != callbackArgument.EndExclusive - 1
            || instructions[callbackArgument.ProducerInstructionIndex].OpCode != OpCodes.Ldftn)
        {
            Fail(
                $"{consumerLabel} publication provider delegate callback is not an immediate ldftn "
                + "argument directly feeding the exact Func constructor.");
        }

        MethodTarget? callbackTarget = mod.TryResolveMethodTarget(
            instructions[callbackArgument.ProducerInstructionIndex].Token,
            instructions[callbackArgument.ProducerInstructionIndex].Offset,
            instructions[callbackArgument.ProducerInstructionIndex].OpCode);
        if (callbackTarget is null || callbackTarget.MethodDefinition is not MethodDefinitionHandle)
            Fail($"{consumerLabel} publication provider delegate callback target is not a method definition.");

        MethodTarget callback = callbackTarget!;
        if (callback.Signature is not MethodSignature<string> callbackSignature
            || callbackSignature.ParameterTypes.Length != 0
            || !IsExactPublicationType(callbackSignature.ReturnType))
        {
            Fail($"{consumerLabel} publication provider callback has an unexpected signature: {FormatSignature(callback.Signature)}.");
        }

        CallbackTrace trace = TraceCapabilityCallback(mod, callback.MethodDefinition!.Value, new HashSet<MethodDefinitionHandle>());
        return new ProviderDelegateBinding(
            construction,
            providerArgument.ProducerInstructionIndex,
            delegateConstructor!,
            callback,
            trace.CaptureKey);
    }

    private static IReadOnlyList<ArgumentExpression> TraceConstructorArguments(
        ArtifactMetadata mod,
        IReadOnlyList<Instruction> instructions,
        int constructorInstructionIndex,
        MethodSignature<string> constructorSignature,
        string consumerLabel,
        int? strictParameterIndex = null)
    {
        int endExclusive = constructorInstructionIndex;
        List<ArgumentExpression> arguments = new(constructorSignature.ParameterTypes.Length);
        for (int parameterIndex = constructorSignature.ParameterTypes.Length - 1; parameterIndex >= 0; parameterIndex--)
        {
            ArgumentExpression expression = TraceStackExpression(
                mod,
                instructions,
                endExclusive,
                $"{consumerLabel} argument {parameterIndex}",
                rejectControlFlow: strictParameterIndex == parameterIndex);
            arguments.Add(expression);
            endExclusive = expression.StartInstructionIndex;
        }

        arguments.Reverse();
        return arguments;
    }

    private static ArgumentExpression TraceStackExpression(
        ArtifactMetadata mod,
        IReadOnlyList<Instruction> instructions,
        int endExclusive,
        string label,
        bool rejectControlFlow)
    {
        const int MaximumImmediateArgumentChainInstructions = 64;
        int neededStackValues = 1;
        int producerInstructionIndex = -1;
        int instructionIndex = endExclusive - 1;
        while (instructionIndex >= 0)
        {
            if (endExclusive - instructionIndex > MaximumImmediateArgumentChainInstructions)
                Fail($"{label} construction chain exceeds the bounded immediate argument window.");

            Instruction instruction = instructions[instructionIndex];
            (int popCount, int pushCount) = GetStackEffect(mod, instruction, label);
            if (producerInstructionIndex < 0 && pushCount >= neededStackValues && pushCount > 0)
                producerInstructionIndex = instructionIndex;

            neededStackValues = pushCount >= neededStackValues
                ? popCount
                : neededStackValues - pushCount + popCount;
            instructionIndex--;
            if (neededStackValues == 0)
                break;
        }

        if (neededStackValues != 0 || producerInstructionIndex < 0)
            Fail($"{label} has no uniquely traceable immediate stack value.");

        int startInstructionIndex = instructionIndex + 1;
        IReadOnlyList<Instruction> expressionInstructions = instructions
            .Skip(startInstructionIndex)
            .Take(endExclusive - startInstructionIndex)
            .ToList();
        if (rejectControlFlow
            && expressionInstructions.Any(instruction => instruction.OpCode.FlowControl is FlowControl.Branch or FlowControl.Cond_Branch or FlowControl.Return or FlowControl.Throw))
            Fail($"{label} immediate argument chain contains a control-flow edge and is ambiguous: {string.Join(", ", expressionInstructions.Select(instruction => $"0x{instruction.Offset:X4}:{instruction.OpCode.Name}"))}.");

        return new ArgumentExpression(
            startInstructionIndex,
            endExclusive,
            producerInstructionIndex,
            expressionInstructions);
    }

    private static (int PopCount, int PushCount) GetStackEffect(
        ArtifactMetadata mod,
        Instruction instruction,
        string label)
    {
        if (instruction.OpCode == OpCodes.Newobj)
        {
            MethodTarget? target = mod.TryResolveMethodTarget(instruction.Token, instruction.Offset, instruction.OpCode);
            if (target?.Signature is not MethodSignature<string> signature)
            {
                Fail($"{label} contains an unresolved newobj stack effect.");
                return (0, 0);
            }
            return (signature.ParameterTypes.Length, 1);
        }

        if (instruction.OpCode == OpCodes.Ldarg
            || instruction.OpCode == OpCodes.Ldarg_S
            || instruction.OpCode == OpCodes.Ldarg_0
            || instruction.OpCode == OpCodes.Ldarg_1
            || instruction.OpCode == OpCodes.Ldarg_2
            || instruction.OpCode == OpCodes.Ldarg_3
            || instruction.OpCode == OpCodes.Ldloc
            || instruction.OpCode == OpCodes.Ldloc_S
            || instruction.OpCode == OpCodes.Ldloc_0
            || instruction.OpCode == OpCodes.Ldloc_1
            || instruction.OpCode == OpCodes.Ldloc_2
            || instruction.OpCode == OpCodes.Ldloc_3
            || instruction.OpCode == OpCodes.Ldnull
            || instruction.OpCode == OpCodes.Ldstr
            || instruction.OpCode == OpCodes.Ldftn
            || instruction.OpCode == OpCodes.Ldvirtftn
            || instruction.OpCode == OpCodes.Ldtoken
            || instruction.OpCode == OpCodes.Ldsfld
            || instruction.OpCode == OpCodes.Ldsflda)
            return (0, 1);

        if (instruction.OpCode == OpCodes.Starg
            || instruction.OpCode == OpCodes.Starg_S
            || instruction.OpCode == OpCodes.Stloc
            || instruction.OpCode == OpCodes.Stloc_S
            || instruction.OpCode == OpCodes.Stloc_0
            || instruction.OpCode == OpCodes.Stloc_1
            || instruction.OpCode == OpCodes.Stloc_2
            || instruction.OpCode == OpCodes.Stloc_3
            || instruction.OpCode == OpCodes.Stsfld)
            return (1, 0);

        if (instruction.OpCode == OpCodes.Dup)
            return (1, 2);
        if (instruction.OpCode == OpCodes.Pop)
            return (1, 0);

        if (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt)
        {
            MethodTarget? target = mod.TryResolveMethodTarget(instruction.Token, instruction.Offset, instruction.OpCode);
            if (target?.Signature is not MethodSignature<string> signature)
            {
                Fail($"{label} contains an unresolved call stack effect.");
                return (0, 0);
            }
            int instanceValue = signature.Header.IsInstance ? 1 : 0;
            int returnValue = IsExactVoidType(signature.ReturnType) ? 0 : 1;
            return (signature.ParameterTypes.Length + instanceValue, returnValue);
        }

        if (instruction.OpCode == OpCodes.Calli)
            Fail($"{label} contains an indirect call whose argument chain is not metadata-resolvable.");

        int popCount = CountStackBehaviour(instruction.OpCode.StackBehaviourPop, label);
        int pushCount = CountStackBehaviour(instruction.OpCode.StackBehaviourPush, label);
        return (popCount, pushCount);
    }

    private static int CountStackBehaviour(StackBehaviour behavior, string label)
    {
        string name = behavior.ToString();
        if (name.StartsWith("Var", StringComparison.Ordinal))
            Fail($"{label} contains a variable stack behaviour that is not metadata-resolvable.");
        if (name.EndsWith("0", StringComparison.Ordinal))
            return 0;
        return name.Count(character => character == '_') + 1;
    }

    private static CallbackTrace TraceCapabilityCallback(
        ArtifactMetadata mod,
        MethodDefinitionHandle method,
        HashSet<MethodDefinitionHandle> visited)
    {
        if (!visited.Add(method))
            Fail("capability provider callback closure contains a recursive method graph.");

        IReadOnlyList<Instruction> instructions = mod.ReadInstructions(method);
        IReadOnlyList<MethodTarget> targets = mod.MethodTargets(instructions);
        IReadOnlyList<FieldTarget> stateFields = mod.FieldTargets(instructions)
            .Where(field => IsScreenStateType(field.FieldType))
            .DistinctBy(field => $"{field.Owner}::{field.Name}:{field.FieldType}")
            .ToList();
        if (targets.Any(target => target.Owner == ScreenStateType && target.Name == "get_CapabilityPublication"))
        {
            if (stateFields.Count == 0)
                Fail("capability provider callback reads ScreenEmbodimentState.CapabilityPublication without a captured ScreenEmbodimentState field.");
            return new CallbackTrace(string.Join(
                "|",
                stateFields
                    .Select(field => $"{field.Owner}::{field.Name}:{field.FieldType}")
                    .OrderBy(value => value, StringComparer.Ordinal)));
        }

        foreach (MethodTarget nestedTarget in targets)
        {
            if (nestedTarget.MethodDefinition is not MethodDefinitionHandle nestedMethod
                || !IsCompilerGeneratedClosure(nestedTarget.Owner))
                continue;

            try
            {
                CallbackTrace nestedTrace = TraceCapabilityCallback(mod, nestedMethod, visited);
                return nestedTrace;
            }
            catch (InvalidOperationException)
            {
                // A compiler-generated sibling closure is not the provider path;
                // continue tracing the other nested target without claiming data flow.
            }
        }

        Fail("capability provider callback target does not access ScreenEmbodimentState.CapabilityPublication.");
        return null!;
    }

    private static void RequireSharedCapabilityState(
        ProviderDelegateBinding executionProvider,
        ProviderDelegateBinding bridgeProvider)
    {
        if (!string.Equals(executionProvider.CaptureKey, bridgeProvider.CaptureKey, StringComparison.Ordinal))
        {
            Fail(
                "ExecutionManager and BridgeSession use split capability authorities: "
                + $"execution={executionProvider.CaptureKey}; bridge={bridgeProvider.CaptureKey}.");
        }
    }

    private static bool IsPublicationProviderDelegateConstructor(MethodTarget target) =>
        target.Name == ".ctor"
        && IsExactPublicationProviderType(target.Owner);

    private static bool IsPublicationProviderParameter(string parameter) =>
        IsExactPublicationProviderType(parameter);

    private static bool IsExactPublicationProviderType(string value) =>
        value == $"System.Func`1<{PublicationType}>"
        || value == $"System.Func<{PublicationType}>";

    private static bool IsExactPublicationType(string value) =>
        value == PublicationType;

    private static bool IsCapabilityAuthorityParameter(string parameter)
    {
        if (parameter.Contains("FarmhandCapabilitySet", StringComparison.Ordinal)
            || parameter.Contains("FarmhandCapabilityPublication", StringComparison.Ordinal)
            || parameter.Contains("FarmhandActionRegistration", StringComparison.Ordinal)
            || parameter.Contains("FarmhandOperationKind", StringComparison.Ordinal)
            || parameter.Contains("EnabledActionSet", StringComparison.Ordinal)
            || IsStringActionIdCollection(parameter))
            return true;

        return parameter.Contains("Capability", StringComparison.Ordinal)
            || parameter.Contains("ActionId", StringComparison.Ordinal)
            || parameter.Contains("Operation", StringComparison.Ordinal);
    }

    private static bool IsStringActionIdCollection(string parameter) =>
        parameter.EndsWith("[]", StringComparison.Ordinal)
            && parameter.StartsWith("System.String", StringComparison.Ordinal)
        || (parameter.Contains("<System.String>", StringComparison.Ordinal)
            && (parameter.Contains("IEnumerable", StringComparison.Ordinal)
                || parameter.Contains("IReadOnlySet", StringComparison.Ordinal)
                || parameter.Contains("IReadOnlyCollection", StringComparison.Ordinal)
                || parameter.Contains("IReadOnlyList", StringComparison.Ordinal)
                || parameter.Contains("ICollection", StringComparison.Ordinal)
                || parameter.Contains("IList", StringComparison.Ordinal)
                || parameter.Contains("List", StringComparison.Ordinal)
                || parameter.Contains("HashSet", StringComparison.Ordinal)
                || parameter.Contains("Immutable", StringComparison.Ordinal)));

    private static bool IsExactVoidType(string value) =>
        value == "System.Void";

    private static bool IsScreenStateType(string value) =>
        value.EndsWith("ScreenEmbodimentState", StringComparison.Ordinal);

    private static bool IsCompilerGeneratedClosure(string owner) =>
        owner.Contains("+<>c", StringComparison.Ordinal);

    private static string FormatSignature(MethodSignature<string>? signature) => signature is MethodSignature<string> value
        ? $"({string.Join(", ", value.ParameterTypes)}) -> {value.ReturnType}"
        : "<unresolved>";

    private static void AssertFailClosedPolicyGuard(
        IReadOnlyList<Instruction> instructions,
        IReadOnlyList<MethodTarget> calls)
    {
        int policyIndex = IndexOfCall(instructions, calls, "GameBuddy.Stardew.ModConfig", "get_HasValidActionPolicy");
        int successorIndex = IndexOfCall(instructions, calls, PublicationType, "WithEnabledActions");
        if (policyIndex >= successorIndex)
            Fail("capability refresh does not check policy validity before deriving a successor.");

        bool validBranchSkipsRejectedPath = instructions
            .Skip(policyIndex + 1)
            .Take(successorIndex - policyIndex - 1)
            .Any(instruction => instruction.OpCode.FlowControl == FlowControl.Cond_Branch
                && instruction.BranchTargetOffset is int target
                && target <= instructions[successorIndex].Offset);
        if (!validBranchSkipsRejectedPath)
            Fail("capability refresh has no conditional branch from the policy gate to the validated successor path.");

        bool rejectedPathExits = instructions
            .Skip(policyIndex + 1)
            .Take(successorIndex - policyIndex - 1)
            .Any(instruction => instruction.OpCode.FlowControl == FlowControl.Branch
                && instruction.BranchTargetOffset is int target
                && target > instructions[successorIndex].Offset);
        if (!rejectedPathExits)
            Fail("invalid capability policy has no fail-closed branch out of the successor path.");
    }

    private static void AssertCoreComposition(ArtifactMetadata core)
    {
        TypeDefinitionHandle publication = core.RequireType(PublicationType);
        TypeDefinitionHandle capabilitySet = core.RequireType(CapabilitySetType);
        TypeDefinitionHandle catalog = core.RequireType(CatalogType);

        IReadOnlyList<MethodDefinitionHandle> publicationConstructors = core.RequireMethods(publication, ".ctor");
        if (publicationConstructors.Any(constructor => !core.IsPrivate(constructor)))
            Fail("FarmhandCapabilityPublication exposes a non-private constructor.");
        AssertPublicStaticFactories(
            core,
            publication,
            new[] { "Initial" },
            "FarmhandCapabilityPublication");

        MethodDefinitionHandle initial = core.RequireMethod(publication, "Initial");
        IReadOnlyList<MethodTarget> initialCalls = core.MethodTargets(core.ReadInstructions(initial));
        RequireOrdered(
            initialCalls,
            (CapabilitySetType, "FromPolicyEnabledOperations"),
            (PublicationType, ".ctor"),
            "publication Initial must compose one Core capability set and one immutable publication");

        MethodDefinitionHandle withEnabledActions = core.RequireMethod(publication, "WithEnabledActions");
        IReadOnlyList<MethodTarget> successorCalls = core.MethodTargets(core.ReadInstructions(withEnabledActions));
        RequireOrdered(
            successorCalls,
            (CapabilitySetType, "FromPolicyEnabledOperations"),
            (PublicationType, ".ctor"),
            "publication refresh must rebuild through the Core set factory and create a successor only after semantic comparison");
        RequireReference(successorCalls, "System.StringComparer", "get_Ordinal", "publication refresh must use ordinal semantic membership comparison");
        RequireReference(successorCalls, PublicationType, "get_CapabilityRevision", "publication successor must be revisioned from the existing publication");

        IReadOnlyList<MethodDefinitionHandle> setMethods = core.RequireMethods(capabilitySet, null);
        MethodDefinitionHandle executionCheck = core.RequireMethod(capabilitySet, "AllowsExecutionAction");
        MethodDefinitionHandle readOnlyCheck = core.RequireMethod(capabilitySet, "AllowsReadOperation");
        RequireFieldReference(
            core.FieldTargets(core.ReadInstructions(executionCheck)),
            CapabilitySetType,
            "gameActions",
            "execution membership must be restricted to the capability set game-action partition");
        RequireFieldReference(
            core.FieldTargets(core.ReadInstructions(readOnlyCheck)),
            CapabilitySetType,
            "readOnlyOperations",
            "read-only membership must be restricted to the capability set read-only partition");

        MethodDefinitionHandle setFactory = core.RequireMethod(capabilitySet, "FromPolicyEnabledOperations");
        IReadOnlyList<Instruction> setFactoryInstructions = core.ReadInstructions(setFactory);
        IReadOnlyList<MethodTarget> factoryTargets = core.MethodTargets(setFactoryInstructions);
        RequireFieldReference(
            core.FieldTargets(setFactoryInstructions),
            CatalogType,
            "Registrations",
            "capability set factory must consume the Core catalog");
        RequireReference(factoryTargets, CapabilitySetType, ".ctor", "capability set factory must be the sole set construction path");
        IReadOnlyList<MethodDefinitionHandle> capabilitySetConstructors = core.RequireMethods(capabilitySet, ".ctor");
        if (capabilitySetConstructors.Any(constructor => !core.IsPrivate(constructor)))
            Fail("FarmhandCapabilitySet exposes a non-private constructor.");
        AssertPublicStaticFactories(
            core,
            capabilitySet,
            new[] { "FromPolicyEnabledOperations" },
            "FarmhandCapabilitySet");
        AssertPrivateConstructorReferences(
            core,
            PublicationType,
            publicationConstructors,
            new[] { "Initial", "WithEnabledActions" },
            "FarmhandCapabilityPublication");
        AssertPrivateConstructorReferences(
            core,
            CapabilitySetType,
            capabilitySetConstructors,
            new[] { "FromPolicyEnabledOperations" },
            "FarmhandCapabilitySet");

        FieldDefinitionHandle registrations = core.RequireField(catalog, "Registrations");
        if (!core.IsStaticReadonly(registrations))
            Fail("FarmhandActionCatalog.Registrations is not a static readonly catalog authority.");

        string registrationType = core.DecodeFieldType(registrations);
        if (!registrationType.Contains("FarmhandActionRegistration", StringComparison.Ordinal))
            Fail("FarmhandActionCatalog.Registrations does not expose typed action registrations.");
    }

    private static void AssertPublicStaticFactories(
        ArtifactMetadata core,
        TypeDefinitionHandle type,
        IReadOnlyList<string> expectedFactoryNames,
        string label)
    {
        HashSet<string> expected = expectedFactoryNames.ToHashSet(StringComparer.Ordinal);
        List<MethodDefinitionHandle> publicStaticMethods = core.RequireMethods(type, null)
            .Where(method => core.IsPublic(method) && core.IsStatic(method))
            .ToList();
        List<string> unexpected = publicStaticMethods
            .Select(core.GetMethodName)
            .Where(name => !expected.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();
        if (unexpected.Count != 0)
            Fail($"{label} exposes unexpected public/static construction factory methods: {string.Join(", ", unexpected)}.");

        foreach (string expectedFactory in expectedFactoryNames)
        {
            MethodDefinitionHandle factory = core.RequireMethod(type, expectedFactory);
            if (!core.IsPublic(factory) || !core.IsStatic(factory))
                Fail($"{label} expected factory {expectedFactory} is not public/static.");
        }
    }

    private static void AssertPrivateConstructorReferences(
        ArtifactMetadata core,
        string typeName,
        IReadOnlyList<MethodDefinitionHandle> constructors,
        IReadOnlyList<string> approvedFactoryNames,
        string label)
    {
        TypeDefinitionHandle type = core.RequireType(typeName);
        HashSet<MethodDefinitionHandle> approvedFactories = approvedFactoryNames
            .Select(name => core.RequireMethod(type, name))
            .ToHashSet();
        HashSet<string> privateConstructorSignatures = constructors
            .Select(method => FormatSignature(core.DecodeMethodSignature(method)))
            .ToHashSet(StringComparer.Ordinal);

        List<(MethodDefinitionHandle Caller, MethodTarget Target)> references = core.AllMethods()
            .SelectMany(method => core.MethodTargets(core.ReadInstructions(method))
                .Where(target => target.Owner == typeName && target.Name == ".ctor")
                .Select(target => (Caller: method, Target: target)))
            .ToList();
        foreach ((MethodDefinitionHandle caller, MethodTarget target) in references)
        {
            if (!approvedFactories.Contains(caller))
            {
                Fail(
                    $"{label} private constructor reference from non-approved method "
                    + $"{core.GetMethodName(caller)}: {FormatSignature(target.Signature)}.");
            }

            if (target.Signature is not MethodSignature<string> signature
                || !privateConstructorSignatures.Contains(FormatSignature(signature)))
            {
                Fail($"{label} approved factory references an unexpected private constructor signature: {FormatSignature(target.Signature)}.");
            }
        }

        foreach (MethodDefinitionHandle constructor in constructors)
        {
            string signature = FormatSignature(core.DecodeMethodSignature(constructor));
            if (!references.Any(reference => FormatSignature(reference.Target.Signature) == signature))
                Fail($"{label} private constructor {core.FormatMethodSignature(constructor)} is not referenced by an approved factory.");
        }
    }

    private static void AssertProviderProjection(ArtifactMetadata mod)
    {
        AssertProviderConsumer(mod, "GameBuddy.Stardew.ExecutionManager");
        AssertProviderConsumer(mod, "GameBuddy.Stardew.BridgeSession");
    }

    private static void AssertProviderConsumer(ArtifactMetadata mod, string typeName)
    {
        TypeDefinitionHandle type = mod.RequireType(typeName);
        FieldDefinitionHandle providerField = mod.RequireField(type, "capabilityPublicationProvider");
        if (!mod.IsReadonly(providerField))
            Fail($"{typeName} capability provider field is mutable.");
        if (!mod.DecodeFieldType(providerField).Contains("FarmhandCapabilityPublication", StringComparison.Ordinal)
            || !mod.DecodeFieldType(providerField).Contains("Func", StringComparison.Ordinal))
            Fail($"{typeName} capability provider field is not Func<FarmhandCapabilityPublication>: {mod.DecodeFieldType(providerField)}.");

        bool hasProviderConstructor = false;
        foreach (MethodDefinitionHandle constructor in mod.RequireMethods(type, ".ctor"))
        {
            MethodSignature<string> signature = mod.DecodeMethodSignature(constructor);
            if (signature.ParameterTypes.Any(parameter => parameter.Contains("FarmhandCapabilityPublication", StringComparison.Ordinal)
                && parameter.Contains("Func", StringComparison.Ordinal)))
                hasProviderConstructor = true;
        }
        if (!hasProviderConstructor)
            Fail($"{typeName} has no constructor accepting the publication provider.");

        IReadOnlyList<MethodTarget> targets = mod.RequireMethods(type, null)
            .SelectMany(method => mod.MethodTargets(mod.ReadInstructions(method)))
            .ToList();
        if (!targets.Any(target => target.Owner.StartsWith("System.Func`1", StringComparison.Ordinal)
            && target.Owner.Contains("FarmhandCapabilityPublication", StringComparison.Ordinal)
            && target.Name == "Invoke"))
            Fail($"{typeName} must project the supplied provider at runtime boundaries.");
        RequireReference(targets, PublicationType, "get_CapabilitySet", $"{typeName} must project publication capability membership");
        RequireAbsent(
            targets,
            new[]
            {
                (PublicationType, "Initial"),
                (PublicationType, "WithEnabledActions"),
                (CapabilitySetType, "FromPolicyEnabledOperations"),
            },
            $"{typeName} must not mint publication or capability-set authority");
    }

    private static int IndexOfCall(
        IReadOnlyList<Instruction> instructions,
        IReadOnlyList<MethodTarget> calls,
        string owner,
        string name)
    {
        foreach (Instruction instruction in instructions)
        {
            if (instruction.Token is not int token || !instruction.IsMethodToken)
                continue;
            MethodTarget? target = calls.FirstOrDefault(candidate => candidate.InstructionOffset == instruction.Offset);
            if (target is not null && target.Owner == owner && target.Name == name)
                for (int instructionIndex = 0; instructionIndex < instructions.Count; instructionIndex++)
                    if (instructions[instructionIndex].Offset == instruction.Offset)
                        return instructionIndex;
        }
        Fail($"missing required call {owner}::{name}.");
        return -1;
    }

    private static void RequireOrdered(
        IReadOnlyList<MethodTarget> targets,
        params object[] values)
    {
        string? failureMessage = values.LastOrDefault() as string;
        int targetIndex = 0;
        int valueCount = failureMessage is null ? values.Length : values.Length - 1;
        for (int valueIndex = 0; valueIndex < valueCount; valueIndex++)
        {
            (string Owner, string Name) expected = ((string Owner, string Name))values[valueIndex];
            while (targetIndex < targets.Count
                && (targets[targetIndex].Owner != expected.Owner || targets[targetIndex].Name != expected.Name))
                targetIndex++;
            if (targetIndex == targets.Count)
            {
                string observed = string.Join(", ", targets.Select(target => $"{target.Owner}::{target.Name}"));
                Fail($"{failureMessage ?? $"missing ordered call {expected.Owner}::{expected.Name}."} Observed: {observed}");
            }
            targetIndex++;
        }
    }

    private static void RequireReference(IReadOnlyList<MethodTarget> targets, string owner, string name, string message)
    {
        if (!targets.Any(target => target.Owner == owner && target.Name == name))
        {
            string observed = string.Join(", ", targets.Where(target => target.Name == name).Select(target => $"{target.Owner}::{target.Name}"));
            Fail($"{message} Observed: {observed}");
        }
    }

    private static void RequireFieldReference(IReadOnlyList<FieldTarget> targets, string owner, string name, string message)
    {
        if (!targets.Any(target => target.Owner == owner && target.Name == name))
            Fail(message);
    }

    private static void RequireAbsent(IReadOnlyList<MethodTarget> targets, IReadOnlyList<(string Owner, string Name)> forbidden, string message)
    {
        if (targets.Any(target => forbidden.Any(item => target.Owner == item.Owner && target.Name == item.Name)))
            Fail(message);
    }

    private static void Fail(string message) => throw new InvalidOperationException(message);

    private sealed class ArtifactMetadata : IDisposable
    {
        private readonly MemoryStream stream;
        private readonly PEReader peReader;
        private readonly Dictionary<MethodDefinitionHandle, TypeDefinitionHandle> methodOwners = new();
        private readonly Dictionary<FieldDefinitionHandle, TypeDefinitionHandle> fieldOwners = new();
        private readonly Dictionary<string, TypeDefinitionHandle> types = new(StringComparer.Ordinal);
        private readonly MetadataReader reader;

        internal ArtifactMetadata(byte[] bytes, string expectedAssemblyName)
        {
            this.stream = new MemoryStream(bytes, writable: false);
            this.peReader = new PEReader(this.stream, PEStreamOptions.PrefetchMetadata | PEStreamOptions.PrefetchEntireImage);
            this.reader = this.peReader.GetMetadataReader();
            string assemblyName = this.reader.GetString(this.reader.GetAssemblyDefinition().Name);
            if (!string.Equals(assemblyName, expectedAssemblyName, StringComparison.Ordinal))
                Fail($"expected {expectedAssemblyName} assembly metadata, got {assemblyName}.");

            foreach (TypeDefinitionHandle typeHandle in this.reader.TypeDefinitions)
            {
                TypeDefinition type = this.reader.GetTypeDefinition(typeHandle);
                this.types[GetTypeName(typeHandle)] = typeHandle;
                foreach (MethodDefinitionHandle method in type.GetMethods())
                    this.methodOwners[method] = typeHandle;
                foreach (FieldDefinitionHandle field in type.GetFields())
                    this.fieldOwners[field] = typeHandle;
            }
        }

        internal TypeDefinitionHandle RequireType(string name)
        {
            if (!this.types.TryGetValue(name, out TypeDefinitionHandle handle))
                Fail($"missing compiled type {name}.");
            return handle;
        }

        internal MethodDefinitionHandle RequireMethod(TypeDefinitionHandle type, string name)
        {
            List<MethodDefinitionHandle> methods = RequireMethods(type, name);
            if (methods.Count != 1)
                Fail($"expected one {name} method on {GetTypeName(type)}, found {methods.Count}.");
            return methods[0];
        }

        internal List<MethodDefinitionHandle> RequireMethods(TypeDefinitionHandle type, string? name)
        {
            TypeDefinition definition = this.reader.GetTypeDefinition(type);
            return definition.GetMethods()
                .Where(method => name is null || this.reader.GetString(this.reader.GetMethodDefinition(method).Name) == name)
                .ToList();
        }

        internal IReadOnlyList<MethodDefinitionHandle> AllMethods() => this.methodOwners.Keys.ToList();

        internal FieldDefinitionHandle RequireField(TypeDefinition type, string name) => throw new NotSupportedException();

        internal FieldDefinitionHandle RequireField(TypeDefinitionHandle type, string name)
        {
            TypeDefinition definition = this.reader.GetTypeDefinition(type);
            List<FieldDefinitionHandle> fields = definition.GetFields()
                .Where(field => this.reader.GetString(this.reader.GetFieldDefinition(field).Name) == name)
                .ToList();
            if (fields.Count != 1)
                Fail($"expected one {name} field on {GetTypeName(type)}, found {fields.Count}.");
            return fields[0];
        }

        internal bool IsPrivate(MethodDefinitionHandle method) => (this.reader.GetMethodDefinition(method).Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Private;

        internal bool IsPublic(MethodDefinitionHandle method) => (this.reader.GetMethodDefinition(method).Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public;

        internal bool IsStatic(MethodDefinitionHandle method) => (this.reader.GetMethodDefinition(method).Attributes & MethodAttributes.Static) != 0;

        internal string GetMethodName(MethodDefinitionHandle method) => this.reader.GetString(this.reader.GetMethodDefinition(method).Name);

        internal string FormatMethodSignature(MethodDefinitionHandle method) =>
            $"{GetMethodName(method)}{FormatSignature(DecodeMethodSignature(method))}";

        internal bool IsReadonly(FieldDefinitionHandle field) => (this.reader.GetFieldDefinition(field).Attributes & FieldAttributes.InitOnly) != 0;

        internal bool IsStaticReadonly(FieldDefinitionHandle field)
        {
            FieldAttributes attributes = this.reader.GetFieldDefinition(field).Attributes;
            return (attributes & FieldAttributes.Static) != 0 && (attributes & FieldAttributes.InitOnly) != 0;
        }

        internal MethodSignature<string> DecodeMethodSignature(MethodDefinitionHandle method) =>
            this.reader.GetMethodDefinition(method).DecodeSignature(new TypeNameProvider(), null);

        internal string DecodeFieldType(FieldDefinitionHandle field) =>
            this.reader.GetFieldDefinition(field).DecodeSignature(new TypeNameProvider(), null);

        internal IReadOnlyList<Instruction> ReadInstructions(MethodDefinitionHandle method)
        {
            MethodDefinition definition = this.reader.GetMethodDefinition(method);
            if (definition.RelativeVirtualAddress == 0)
                return Array.Empty<Instruction>();
            MethodBodyBlock body = this.peReader.GetMethodBody(definition.RelativeVirtualAddress);
            return IlReader.Read(body.GetILBytes() ?? Array.Empty<byte>());
        }

        internal IReadOnlyList<MethodTarget> MethodTargets(IReadOnlyList<Instruction> instructions) => instructions
            .Where(instruction => instruction.IsMethodToken)
            .Select(instruction => TryResolveMethodTarget(instruction.Token, instruction.Offset, instruction.OpCode))
            .Where(target => target is not null)
            .Cast<MethodTarget>()
            .ToList();

        internal IReadOnlyList<FieldTarget> FieldTargets(IReadOnlyList<Instruction> instructions) => instructions
            .Where(instruction => instruction.IsFieldToken)
            .Select(instruction => TryResolveFieldTarget(instruction.Token, instruction.Offset))
            .Where(target => target is not null)
            .Cast<FieldTarget>()
            .ToList();

        internal FieldTarget? TryResolveFieldTarget(int? token, int instructionOffset = -1)
        {
            if (token is not int rawToken)
                return null;
            EntityHandle handle;
            try { handle = MetadataTokens.EntityHandle(rawToken); }
            catch (ArgumentException) { return null; }
            if (handle.Kind != HandleKind.FieldDefinition && handle.Kind != HandleKind.MemberReference)
                return null;
            if (handle.Kind == HandleKind.FieldDefinition)
            {
                FieldDefinitionHandle field = (FieldDefinitionHandle)handle;
                FieldDefinition definition = this.reader.GetFieldDefinition(field);
                return new FieldTarget(
                    GetTypeName(this.fieldOwners[field]),
                    this.reader.GetString(definition.Name),
                    field,
                    instructionOffset,
                    definition.DecodeSignature(new TypeNameProvider(), null));
            }
            MemberReference reference = this.reader.GetMemberReference((MemberReferenceHandle)handle);
            return new FieldTarget(
                GetTypeName(reference.Parent),
                this.reader.GetString(reference.Name),
                null,
                instructionOffset,
                reference.DecodeFieldSignature(new TypeNameProvider(), null));
        }

        internal MethodTarget? TryResolveMethodTarget(int? token, int instructionOffset = -1, OpCode? opCode = null)
        {
            if (token is not int rawToken)
                return null;
            EntityHandle handle;
            try { handle = MetadataTokens.EntityHandle(rawToken); }
            catch (ArgumentException) { return null; }

            if (handle.Kind == HandleKind.MethodDefinition)
            {
                MethodDefinitionHandle method = (MethodDefinitionHandle)handle;
                MethodDefinition definition = this.reader.GetMethodDefinition(method);
                return new MethodTarget(
                    GetTypeName(this.methodOwners[method]),
                    this.reader.GetString(definition.Name),
                    method,
                    instructionOffset,
                    opCode,
                    definition.DecodeSignature(new TypeNameProvider(), null));
            }
            if (handle.Kind == HandleKind.MemberReference)
            {
                MemberReference reference = this.reader.GetMemberReference((MemberReferenceHandle)handle);
                return new MethodTarget(
                    GetTypeName(reference.Parent),
                    this.reader.GetString(reference.Name),
                    null,
                    instructionOffset,
                    opCode,
                    reference.DecodeMethodSignature(new TypeNameProvider(), null));
            }
            return null;
        }

        private string GetTypeName(TypeDefinitionHandle type)
        {
            TypeDefinition definition = this.reader.GetTypeDefinition(type);
            string name = this.reader.GetString(definition.Name);
            if (definition.GetDeclaringType().IsNil)
            {
                string ns = this.reader.GetString(definition.Namespace);
                return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
            }
            return $"{GetTypeName(definition.GetDeclaringType())}+{name}";
        }

        private string GetTypeName(EntityHandle handle)
        {
            return handle.Kind switch
            {
                HandleKind.TypeDefinition => GetTypeName((TypeDefinitionHandle)handle),
                HandleKind.TypeReference => GetTypeName((TypeReferenceHandle)handle),
                HandleKind.TypeSpecification => this.reader.GetTypeSpecification((TypeSpecificationHandle)handle).DecodeSignature(new TypeNameProvider(), null),
                _ => string.Empty,
            };
        }

        private string GetTypeName(TypeReferenceHandle type)
        {
            TypeReference reference = this.reader.GetTypeReference(type);
            string name = this.reader.GetString(reference.Name);
            string ns = this.reader.GetString(reference.Namespace);
            return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
        }

        public void Dispose()
        {
            this.peReader.Dispose();
            this.stream.Dispose();
        }
    }

    private sealed record ConstructionSite(
        int InstructionIndex,
        Instruction Instruction,
        MethodTarget Constructor,
        int ProviderParameterIndex = -1);

    private sealed record ArgumentExpression(
        int StartInstructionIndex,
        int EndExclusive,
        int ProducerInstructionIndex,
        IReadOnlyList<Instruction> Instructions);

    private sealed record ProviderDelegateBinding(
        ConstructionSite Construction,
        int DelegateInstructionIndex,
        MethodTarget DelegateConstructor,
        MethodTarget Callback,
        string CaptureKey);

    private sealed record CallbackTrace(string CaptureKey);

    private sealed record MethodTarget(
        string Owner,
        string Name,
        MethodDefinitionHandle? MethodDefinition,
        int InstructionOffset,
        OpCode? OpCode,
        MethodSignature<string>? Signature);

    private sealed record FieldTarget(
        string Owner,
        string Name,
        FieldDefinitionHandle? FieldDefinition,
        int InstructionOffset,
        string FieldType);

    private sealed record Instruction(
        int Offset,
        OpCode OpCode,
        int? Token,
        bool IsMethodToken,
        bool IsFieldToken,
        int? BranchTargetOffset,
        int Size);

    private static class IlReader
    {
        private static readonly IReadOnlyDictionary<short, OpCode> OpCodesByValue = typeof(OpCodes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.FieldType == typeof(OpCode))
            .Select(field => (OpCode)field.GetValue(null)!)
            .GroupBy(opCode => opCode.Value)
            .ToDictionary(group => group.Key, group => group.First());

        internal static IReadOnlyList<Instruction> Read(byte[] il)
        {
            List<Instruction> instructions = new();
            int offset = 0;
            while (offset < il.Length)
            {
                int instructionOffset = offset;
                short opcodeValue;
                byte first = il[offset++];
                if (first == 0xFE)
                    opcodeValue = (short)(0xFE00 | il[offset++]);
                else
                    opcodeValue = first;
                if (!OpCodesByValue.TryGetValue(opcodeValue, out OpCode opCode))
                    Fail($"unknown IL opcode 0x{opcodeValue:X4} at offset {instructionOffset}.");

                int? token = null;
                int? branchTarget = null;
                int operandSize = OperandSize(opCode.OperandType, il, offset, out int? operandValue);
                if (opCode.OperandType is OperandType.InlineMethod or OperandType.InlineField or OperandType.InlineType or OperandType.InlineTok or OperandType.InlineString or OperandType.InlineSig)
                    token = BitConverter.ToInt32(il, offset);
                if (opCode.OperandType is OperandType.ShortInlineBrTarget or OperandType.InlineBrTarget)
                    branchTarget = instructionOffset + opCode.Size + operandSize + operandValue!.Value;
                offset += operandSize;
                instructions.Add(new Instruction(
                    instructionOffset,
                    opCode,
                    token,
                    opCode.OperandType == OperandType.InlineMethod,
                    opCode.OperandType == OperandType.InlineField,
                    branchTarget,
                    offset - instructionOffset));
            }
            return instructions;
        }

        private static int OperandSize(OperandType operandType, byte[] il, int offset, out int? branchValue)
        {
            branchValue = null;
            switch (operandType)
            {
                case OperandType.InlineNone: return 0;
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                case OperandType.ShortInlineBrTarget:
                    if (operandType == OperandType.ShortInlineBrTarget) branchValue = (sbyte)il[offset];
                    return 1;
                case OperandType.InlineVar: return 2;
                case OperandType.InlineI:
                case OperandType.InlineField:
                case OperandType.InlineI8:
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineString:
                case OperandType.InlineTok:
                case OperandType.InlineType:
                case OperandType.InlineBrTarget:
                    if (operandType == OperandType.InlineBrTarget) branchValue = BitConverter.ToInt32(il, offset);
                    return operandType == OperandType.InlineI8 ? 8 : operandType == OperandType.InlineBrTarget || operandType == OperandType.InlineI ? 4 : 4;
                case OperandType.ShortInlineR: return 4;
                case OperandType.InlineR: return 8;
                case OperandType.InlineSwitch:
                    int count = BitConverter.ToInt32(il, offset);
                    return 4 + (count * 4);
                default:
                    Fail($"unsupported IL operand type {operandType}.");
                    return 0;
            }
        }
    }

    private sealed class TypeNameProvider : ISignatureTypeProvider<string, object?>
    {
        public string GetArrayType(string elementType, ArrayShape shape) => $"{elementType}[{new string(',', shape.Rank - 1)}]";
        public string GetByReferenceType(string elementType) => $"{elementType}&";
        public string GetFunctionPointerType(MethodSignature<string> signature) => "methodptr";
        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) => $"{genericType}<{string.Join(",", typeArguments)}>";
        public string GetGenericMethodParameter(object? genericContext, int index) => $"!!{index}";
        public string GetGenericTypeParameter(object? genericContext, int index) => $"!{index}";
        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;
        public string GetPinnedType(string elementType) => elementType;
        public string GetPointerType(string elementType) => $"{elementType}*";
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode switch
        {
            PrimitiveTypeCode.Void => "System.Void",
            PrimitiveTypeCode.Boolean => "System.Boolean",
            PrimitiveTypeCode.Char => "System.Char",
            PrimitiveTypeCode.SByte => "System.SByte",
            PrimitiveTypeCode.Byte => "System.Byte",
            PrimitiveTypeCode.Int16 => "System.Int16",
            PrimitiveTypeCode.UInt16 => "System.UInt16",
            PrimitiveTypeCode.Int32 => "System.Int32",
            PrimitiveTypeCode.UInt32 => "System.UInt32",
            PrimitiveTypeCode.Int64 => "System.Int64",
            PrimitiveTypeCode.UInt64 => "System.UInt64",
            PrimitiveTypeCode.Single => "System.Single",
            PrimitiveTypeCode.Double => "System.Double",
            PrimitiveTypeCode.String => "System.String",
            PrimitiveTypeCode.TypedReference => "System.TypedReference",
            PrimitiveTypeCode.IntPtr => "System.IntPtr",
            PrimitiveTypeCode.UIntPtr => "System.UIntPtr",
            PrimitiveTypeCode.Object => "System.Object",
            _ => typeCode.ToString(),
        };
        public string GetSZArrayType(string elementType) => $"{elementType}[]";
        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) => GetTypeName(reader.GetTypeDefinition(handle), reader);
        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) => GetTypeName(reader.GetTypeReference(handle), reader);
        public string GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

        private static string GetTypeName(TypeDefinition definition, MetadataReader reader)
        {
            string name = reader.GetString(definition.Name);
            string ns = reader.GetString(definition.Namespace);
            return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
        }

        private static string GetTypeName(TypeReference reference, MetadataReader reader)
        {
            string name = reader.GetString(reference.Name);
            string ns = reader.GetString(reference.Namespace);
            return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
        }
    }
}
