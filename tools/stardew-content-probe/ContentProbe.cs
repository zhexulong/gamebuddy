using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

if (args.Length != 1)
{
    Console.Error.WriteLine("usage: ContentProbe <game-root>");
    return 2;
}

var root = Path.GetFullPath(args[0]);
var assemblyPath = Path.Combine(root, "Stardew Valley.dll");
var contentRoot = Path.Combine(root, "Content");
if (!File.Exists(assemblyPath) || !Directory.Exists(contentRoot))
{
    Console.Error.WriteLine("target_missing");
    return 3;
}

Func<AssemblyLoadContext, AssemblyName, Assembly?> resolving = (_, name) =>
{
    var candidate = Path.Combine(root, $"{name.Name}.dll");
    return File.Exists(candidate) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(candidate) : null;
};
AssemblyLoadContext.Default.Resolving += resolving;
try
{
    var gameAssembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(assemblyPath);
    var managerType = gameAssembly.GetType("StardewValley.LocalizedContentManager", throwOnError: true)!;
    var dataLoaderType = gameAssembly.GetType("StardewValley.DataLoader", throwOnError: true)!;
    var constructor = managerType.GetConstructor(
        BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
        binder: null,
        types: new[] { typeof(IServiceProvider), typeof(string) },
        modifiers: null);
    if (constructor is null)
    {
        Console.Error.WriteLine("localized_content_manager_constructor_missing");
        return 4;
    }

    var manager = constructor.Invoke(new object?[] { new ServiceProviderStub(), contentRoot });
    var tables = new List<object>();
    foreach (var method in dataLoaderType.GetMethods(BindingFlags.Public | BindingFlags.Static).OrderBy(method => method.Name))
    {
        if (method.Name is "Load" or "Get") continue;
        var parameters = method.GetParameters();
        if (parameters.Length != 1 || parameters[0].ParameterType != managerType) continue;

        try
        {
            var value = method.Invoke(null, new[] { manager });
            tables.Add(new
            {
                method = method.Name,
                asset = $"Data/{method.Name}",
                returnType = method.ReturnType.FullName,
                state = "loaded",
                count = Count(value),
                keySample = KeySample(value),
            });
        }
        catch (Exception error)
        {
            tables.Add(new
            {
                method = method.Name,
                asset = $"Data/{method.Name}",
                returnType = method.ReturnType.FullName,
                state = "load_failed",
                count = (int?)null,
                keySample = Array.Empty<string>(),
                error = error.InnerException?.GetType().FullName ?? error.GetType().FullName,
            });
        }
    }

    object MachinesContentSnapshot()
    {
        var machinesMethod = dataLoaderType.GetMethod("Machines", BindingFlags.Public | BindingFlags.Static, new[] { managerType });
        if (machinesMethod is null)
            return new { state = "load_failed", entries = Array.Empty<object>(), error = "machines_loader_missing" };
        try
        {
            var value = machinesMethod.Invoke(null, new[] { manager });
            if (value is not IDictionary dictionary)
                return new { state = "load_failed", entries = Array.Empty<object>(), error = "machines_dictionary_missing" };
            var entries = dictionary.Cast<object>()
                .Select(entry =>
                {
                    var entryType = entry.GetType();
                    var definition = entryType.GetProperty("Value")?.GetValue(entry);
                    var key = entryType.GetProperty("Key")?.GetValue(entry)?.ToString() ?? "<null>";
                    var machineFields = new[] { "HasInput", "HasOutput", "InteractMethod", "OutputRules", "AdditionalConsumedItems", "PreventTimePass", "ReadyTimeModifiers", "ReadyTimeModifierMode", "InvalidItemMessage", "InvalidItemMessageCondition", "InvalidCountMessage", "LoadEffects", "WorkingEffects", "WorkingEffectChance", "AllowLoadWhenFull", "WobbleWhileWorking", "LightWhileWorking", "ShowNextIndexWhileWorking", "ShowNextIndexWhenReady", "AllowFairyDust", "IsIncubator", "OnlyCompleteOvernight", "ClearContentsOvernightCondition", "StatsToIncrementWhenLoaded", "StatsToIncrementWhenHarvested", "ExperienceGainOnHarvest", "CustomFields" };
                    var shapeFailures = new List<string>();
                    var shapeEvidence = new List<object>();
                    var rules = EnumerableValues(PropertyValue(definition, "OutputRules"))
                        .Select((rule, index) => new
                        {
                            index,
                            unknownFields = MissingFields(rule, new[] { "Id", "Triggers", "UseFirstValidOutput", "OutputItem", "MinutesUntilReady", "DaysUntilReady", "InvalidCountMessage", "RecalculateOnCollect" }),
                            ruleId = StringProperty(rule, "Id") ?? string.Empty,
                            triggers = EnumerableValues(PropertyValue(rule, "Triggers")).Select(trigger => new
                            {
                                unknownFields = MissingFields(trigger, new[] { "Trigger", "RequiredItemId", "RequiredCount", "RequiredTags", "Condition" }),
                                trigger = StringProperty(trigger, "Trigger") ?? string.Empty,
                                requiredItemId = StringProperty(trigger, "RequiredItemId") ?? string.Empty,
                                requiredCount = IntProperty(trigger, "RequiredCount"),
                                requiredTags = RawStringValues(PropertyValue(trigger, "RequiredTags")),
                                condition = StringProperty(trigger, "Condition") ?? string.Empty,
                            }).ToArray(),
                            outputs = EnumerableValues(PropertyValue(rule, "OutputItem")).Select((output, outputIndex) => new
                            {
                                unknownFields = MissingFields(output, new[] { "ItemId", "RandomItemId", "MaxItems", "MinStack", "MaxStack", "Quality", "ObjectInternalName", "ObjectDisplayName", "ObjectColor", "ToolUpgradeLevel", "IsRecipe", "StackModifiers", "StackModifierMode", "QualityModifiers", "QualityModifierMode", "ModData", "PerItemCondition", "Condition", "OutputMethod", "CustomData", "CopyColor", "CopyPrice", "CopyQuality", "PreserveType", "PreserveId", "IncrementMachineParentSheetIndex", "PriceModifiers", "PriceModifierMode" }),
                                itemId = StringProperty(output, "ItemId") ?? string.Empty,
                                randomItemIds = RawStringValues(PropertyValue(output, "RandomItemId")),
                                maxItems = NullableIntProperty(output, "MaxItems"),
                                minStack = IntProperty(output, "MinStack"),
                                maxStack = IntProperty(output, "MaxStack"),
                                quality = IntProperty(output, "Quality"),
                                objectInternalName = StringProperty(output, "ObjectInternalName") ?? string.Empty,
                                objectDisplayName = StringProperty(output, "ObjectDisplayName") ?? string.Empty,
                                objectColor = StringProperty(output, "ObjectColor") ?? string.Empty,
                                toolUpgradeLevel = IntProperty(output, "ToolUpgradeLevel"),
                                isRecipe = BoolProperty(output, "IsRecipe") ?? false,
                                stackModifiers = QuantityModifiersWithShape(output, "StackModifiers", $"machine[{key}].outputRules[{index}].outputs[{outputIndex}].stackModifiers", shapeFailures, shapeEvidence),
                                stackModifierMode = StringProperty(output, "StackModifierMode") ?? string.Empty,
                                qualityModifiers = QuantityModifiersWithShape(output, "QualityModifiers", $"machine[{key}].outputRules[{index}].outputs[{outputIndex}].qualityModifiers", shapeFailures, shapeEvidence),
                                qualityModifierMode = StringProperty(output, "QualityModifierMode") ?? string.Empty,
                                modData = StringPairsWithShape(output, "ModData", $"machine[{key}].outputRules[{index}].outputs[{outputIndex}].modData", shapeFailures, shapeEvidence),
                                perItemCondition = StringProperty(output, "PerItemCondition") ?? string.Empty,
                                condition = StringProperty(output, "Condition") ?? string.Empty,
                                outputMethod = StringProperty(output, "OutputMethod") ?? string.Empty,
                                customData = StringPairsWithShape(output, "CustomData", $"machine[{key}].outputRules[{index}].outputs[{outputIndex}].customData", shapeFailures, shapeEvidence),
                                copyColor = BoolProperty(output, "CopyColor") ?? false,
                                copyPrice = BoolProperty(output, "CopyPrice") ?? false,
                                copyQuality = BoolProperty(output, "CopyQuality") ?? false,
                                preserveType = StringProperty(output, "PreserveType") ?? string.Empty,
                                preserveId = StringProperty(output, "PreserveId") ?? string.Empty,
                                incrementMachineParentSheetIndex = IntProperty(output, "IncrementMachineParentSheetIndex"),
                                priceModifiers = QuantityModifiersWithShape(output, "PriceModifiers", $"machine[{key}].outputRules[{index}].outputs[{outputIndex}].priceModifiers", shapeFailures, shapeEvidence),
                                priceModifierMode = StringProperty(output, "PriceModifierMode") ?? string.Empty,
                            }).ToArray(),
                            minutesUntilReady = IntProperty(rule, "MinutesUntilReady"),
                            daysUntilReady = IntProperty(rule, "DaysUntilReady"),
                            invalidCountMessage = StringProperty(rule, "InvalidCountMessage") ?? string.Empty,
                            useFirstValidOutput = BoolProperty(rule, "UseFirstValidOutput") ?? false,
                            recalculateOnCollect = BoolProperty(rule, "RecalculateOnCollect") ?? false,
                        }).ToArray();
                    return new
                    {
                        shapeFailures = shapeFailures.OrderBy(failure => failure, StringComparer.Ordinal).ToArray(),
                        shapeEvidence = shapeEvidence.OrderBy(evidence => evidence.ToString(), StringComparer.Ordinal).ToArray(),
                        unknownFields = MissingFields(definition, machineFields),
                        machineId = key,
                        hasInput = BoolProperty(definition, "HasInput") ?? false,
                        hasOutput = BoolProperty(definition, "HasOutput") ?? false,
                        loadEffects = StructuredValue(PropertyValue(definition, "LoadEffects")),
                        workingEffects = StructuredValue(PropertyValue(definition, "WorkingEffects")),
                        workingEffectChance = PropertyValue(definition, "WorkingEffectChance")?.ToString() ?? string.Empty,
                        wobbleWhileWorking = BoolProperty(definition, "WobbleWhileWorking"),
                        lightWhileWorking = StructuredValue(PropertyValue(definition, "LightWhileWorking")),
                        showNextIndexWhileWorking = BoolProperty(definition, "ShowNextIndexWhileWorking"),
                        showNextIndexWhenReady = BoolProperty(definition, "ShowNextIndexWhenReady"),
                        allowFairyDust = BoolProperty(definition, "AllowFairyDust"),
                        isIncubator = BoolProperty(definition, "IsIncubator"),
                        hasInputRules = rules.Length > 0,
                        outputRuleCount = rules.Length,
                        allowLoadWhenFull = BoolProperty(definition, "AllowLoadWhenFull") ?? false,
                        onlyCompleteOvernight = BoolProperty(definition, "OnlyCompleteOvernight") ?? false,
                        recalculateOnCollect = BoolProperty(definition, "RecalculateOnCollect") ?? false,
                        additionalConsumedItems = AdditionalConsumedItems(definition, "AdditionalConsumedItems", $"machine[{key}].additionalConsumedItems", shapeFailures, shapeEvidence),
                        preventTimePass = StringValues(definition, "PreventTimePass", $"machine[{key}].preventTimePass", shapeFailures, shapeEvidence),
                        readyTimeModifiers = QuantityModifiersWithShape(definition, "ReadyTimeModifiers", $"machine[{key}].readyTimeModifiers", shapeFailures, shapeEvidence),
                        readyTimeModifierMode = StringProperty(definition, "ReadyTimeModifierMode") ?? string.Empty,
                        clearContentsOvernightCondition = StringProperty(definition, "ClearContentsOvernightCondition") ?? string.Empty,
                        invalidItemMessage = StringProperty(definition, "InvalidItemMessage") ?? string.Empty,
                        invalidItemMessageCondition = StringProperty(definition, "InvalidItemMessageCondition") ?? string.Empty,
                        invalidCountMessage = StringProperty(definition, "InvalidCountMessage") ?? string.Empty,
                        statsToIncrementWhenLoaded = StatIncrements(PropertyValue(definition, "StatsToIncrementWhenLoaded")),
                        statsToIncrementWhenHarvested = StatIncrements(PropertyValue(definition, "StatsToIncrementWhenHarvested")),
                        experienceGainOnHarvest = StringProperty(definition, "ExperienceGainOnHarvest") ?? string.Empty,
                        customFields = StringPairsWithShape(definition, "CustomFields", $"machine[{key}].customFields", shapeFailures, shapeEvidence),
                        outputCollected = StringProperty(definition, "OutputCollected") ?? string.Empty,
                        interactMethod = StringProperty(definition, "InteractMethod") ?? string.Empty,
                        outputRules = rules,
                    };
                })
                .OrderBy(entry => entry.machineId, StringComparer.Ordinal)
                .ToArray();
            return new { state = "loaded", entries, digest = Digest(entries.Select(entry => $"{entry.machineId}\t{entry.hasInputRules}\t{entry.outputRuleCount}\t{entry.allowLoadWhenFull}\t{entry.onlyCompleteOvernight}\t{entry.recalculateOnCollect}\t{entry.outputCollected}\t{entry.interactMethod}")) };
        }
        catch (Exception error)
        {
            return new { state = "load_failed", entries = Array.Empty<object>(), error = error.InnerException?.GetType().FullName ?? error.GetType().FullName };
        }
    }

    object ObjectsContentSnapshot()
    {
        var objectsMethod = dataLoaderType.GetMethod("Objects", BindingFlags.Public | BindingFlags.Static, new[] { managerType });
        if (objectsMethod is null)
            return new { state = "load_failed", entries = Array.Empty<object>(), error = "objects_loader_missing" };
        try
        {
            var value = objectsMethod.Invoke(null, new[] { manager });
            if (value is not IDictionary dictionary)
                return new { state = "load_failed", entries = Array.Empty<object>(), error = "objects_dictionary_missing" };
            var entries = dictionary.Cast<object>()
                .Select(entry =>
                {
                    var entryType = entry.GetType();
                    var definition = entryType.GetProperty("Value")?.GetValue(entry);
                    var key = entryType.GetProperty("Key")?.GetValue(entry)?.ToString() ?? "<null>";
                    return new
                    {
                        itemId = key,
                        name = StringProperty(definition, "Name") ?? string.Empty,
                        displayName = StringProperty(definition, "DisplayName") ?? string.Empty,
                        description = StringProperty(definition, "Description") ?? string.Empty,
                        category = IntProperty(definition, "Category"),
                        type = StringProperty(definition, "Type") ?? string.Empty,
                        contextTags = RawStringValues(PropertyValue(definition, "ContextTags")),
                        unknownFields = MissingFields(definition, new[] { "Name", "DisplayName", "Description", "Category", "Type", "ContextTags" }),
                    };
                })
                .OrderBy(entry => entry.itemId, StringComparer.Ordinal)
                .ToArray();
            return new { state = "loaded", entries, digest = Digest(entries.Select(entry => $"{entry.itemId}\t{entry.name}\t{entry.displayName}\t{entry.description}\t{entry.category}\t{entry.type}\t{string.Join(",", entry.contextTags)}")) };
        }
        catch (Exception error)
        {
            return new { state = "load_failed", entries = Array.Empty<object>(), error = error.InnerException?.GetType().FullName ?? error.GetType().FullName };
        }
    }

    object ToolContentSnapshot()
    {
        var toolsMethod = dataLoaderType.GetMethod("Tools", BindingFlags.Public | BindingFlags.Static, new[] { managerType });
        if (toolsMethod is null)
            return new { state = "load_failed", entries = Array.Empty<object>(), error = "tools_loader_missing" };
        try
        {
            var value = toolsMethod.Invoke(null, new[] { manager });
            if (value is not IDictionary dictionary)
                return new { state = "load_failed", entries = Array.Empty<object>(), error = "tools_dictionary_missing" };
            var entries = dictionary.Cast<object>()
                .Select(entry =>
                {
                    var entryType = entry.GetType();
                    var definition = entryType.GetProperty("Value")?.GetValue(entry);
                    var key = entryType.GetProperty("Key")?.GetValue(entry);
                    return new
                    {
                        itemId = key?.ToString() ?? "<null>",
                        className = StringProperty(definition, "ClassName"),
                        upgradeLevel = IntProperty(definition, "UpgradeLevel"),
                        instantUse = BoolProperty(definition, "InstantUse") ?? false,
                        attachmentSlots = IntProperty(definition, "AttachmentSlots"),
                    };
                })
                .OrderBy(entry => entry.itemId, StringComparer.Ordinal)
                .ToArray();
            return new { state = "loaded", entries, digest = Digest(entries.Select(entry => $"{entry.itemId}\t{entry.className}\t{entry.upgradeLevel}\t{entry.instantUse}\t{entry.attachmentSlots}")) };
        }
        catch (Exception error)
        {
            return new { state = "load_failed", entries = Array.Empty<object>(), error = error.InnerException?.GetType().FullName ?? error.GetType().FullName };
        }
    }

    var output = new
    {
        state = "probed",
        gameAssemblyVersion = gameAssembly.GetName().Version?.ToString(),
        dataLoaderType = dataLoaderType.FullName,
        tableCount = tables.Count,
        tables,
        objectsContent = ObjectsContentSnapshot(),
        toolContent = ToolContentSnapshot(),
        machinesContent = MachinesContentSnapshot(),
    };
    Console.WriteLine(JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = false }));
    return 0;
}
finally
{
    AssemblyLoadContext.Default.Resolving -= resolving;
}

static int? Count(object? value) => value switch
{
    ICollection collection => collection.Count,
    IEnumerable enumerable => enumerable.Cast<object?>().Count(),
    _ => null,
};

static string[] KeySample(object? value)
{
    if (value is IDictionary dictionary)
    {
        return dictionary.Keys
            .Cast<object?>()
            .Select(key => key?.ToString() ?? "<null>")
            .Take(8)
            .ToArray();
    }

    return Array.Empty<string>();
}

static MemberResolution ResolveMember(object? owner, string name)
{
    if (owner is null) return new(false, null, null, false, null);
    var type = owner.GetType();
    var property = type.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
    if (property is not null) return new(true, property, property.PropertyType, HasSourceOptional(property), property.GetValue(owner));
    var field = type.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
    if (field is not null) return new(true, field, field.FieldType, HasSourceOptional(field), field.GetValue(owner));
    return new(false, null, null, false, null);
}
static bool HasSourceOptional(MemberInfo member) => member.GetCustomAttributes(true).Any(attribute => attribute.GetType().Name == "ContentSerializerAttribute" && attribute.GetType().GetProperty("Optional")?.GetValue(attribute) is true);
static object? PropertyValue(object? value, string name) => ResolveMember(value, name).Value;
static string? StringProperty(object? value, string name) => PropertyValue(value, name)?.ToString();
static int? IntProperty(object? value, string name) => PropertyValue(value, name) switch { int result => result, _ => null };
static int? NullableIntProperty(object? value, string name) => PropertyValue(value, name) switch { int result => result, _ => null };
static bool? BoolProperty(object? value, string name) => PropertyValue(value, name) switch { bool result => result, _ => null };
static IEnumerable<object?> EnumerableValues(object? value) => value is IEnumerable enumerable ? enumerable.Cast<object?>() : Array.Empty<object?>();
static object?[] CollectionValues(object? owner, string memberName, string path, List<string> shapeFailures, List<object> shapeEvidence)
{
    var resolution = ResolveMember(owner, memberName);
    if (!resolution.Found) { shapeFailures.Add($"{path}:missing_member"); return Array.Empty<object?>(); }
    if (resolution.Value is null)
    {
        if (IsAllowlistedOptionalCollection(memberName, resolution))
        {
            shapeEvidence.Add(new { path, status = "documented_absent", member = memberName, declaredType = resolution.DeclaredType!.FullName, sourceOptional = true, runtimeType = (string?)null });
            return Array.Empty<object?>();
        }
        shapeFailures.Add($"{path}:nonnullable_null"); return Array.Empty<object?>();
    }
    if (!IsSupportedDeclaredCollection(memberName, resolution.DeclaredType)) { shapeFailures.Add($"{path}:unsupported_declared_shape:{resolution.DeclaredType?.FullName ?? "<null>"}"); return Array.Empty<object?>();
    }
    if (memberName is "ModData" or "CustomData")
    {
        if (resolution.Value is not IDictionary) { shapeFailures.Add($"{path}:unsupported_runtime_shape:{resolution.Value.GetType().FullName ?? resolution.Value.GetType().Name}"); return Array.Empty<object?>(); }
        return Array.Empty<object?>();
    }
    if (resolution.Value is string || resolution.Value is IDictionary || resolution.Value is not IEnumerable enumerable) { shapeFailures.Add($"{path}:unsupported_runtime_shape:{resolution.Value.GetType().FullName ?? resolution.Value.GetType().Name}"); return Array.Empty<object?>(); }
    return enumerable.Cast<object?>().ToArray();
}
static bool IsAllowlistedOptionalCollection(string memberName, MemberResolution resolution) => memberName is "StackModifiers" or "QualityModifiers" or "PriceModifiers" or "ModData" or "CustomData" && resolution.SourceOptional && IsSupportedDeclaredCollection(memberName, resolution.DeclaredType);
static bool IsSupportedDeclaredCollection(string memberName, Type? type)
{
    if (type is null || !type.IsGenericType) return false;
    var definition = type.GetGenericTypeDefinition(); var args = type.GetGenericArguments();
    if (memberName is "StackModifiers" or "QualityModifiers" or "PriceModifiers") return definition == typeof(List<>) && args[0].Name == "QuantityModifier";
    return definition == typeof(Dictionary<,>) && args[0] == typeof(string) && args[1] == typeof(string);
}
static string[] RawStringValues(object? value)
    => EnumerableValues(value).Select(item => item?.ToString() ?? "<null>").ToArray();
static string[] StringValues(object? owner, string memberName, string path, List<string> shapeFailures, List<object> shapeEvidence)
    => CollectionValues(owner, memberName, path, shapeFailures, shapeEvidence).Select(item => item?.ToString() ?? "<null>").ToArray();
static string[] MissingFields(object? value, IEnumerable<string> names)
    => names.Where(name => value?.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is null && value?.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is null).ToArray();
static object StructuredValue(object? value) => value switch
{
    null => Array.Empty<object>(),
    IEnumerable enumerable when value is not string => enumerable.Cast<object?>().Select(item => item?.ToString() ?? "<null>").ToArray(),
    _ => value.ToString() ?? string.Empty,
};
static object[] StatIncrements(object? value) => EnumerableValues(value).Select(item => (object)new
{
    id = StringProperty(item, "Id") ?? string.Empty,
    requiredItemId = StringProperty(item, "RequiredItemId") ?? string.Empty,
    requiredTags = RawStringValues(PropertyValue(item, "RequiredTags")),
    statName = StringProperty(item, "StatName") ?? string.Empty,
}).ToArray();
static object[] AdditionalConsumedItems(object? owner, string memberName, string path, List<string> shapeFailures, List<object> shapeEvidence) => CollectionValues(owner, memberName, path, shapeFailures, shapeEvidence).Select(item => (object)new
{
    itemId = StringProperty(item, "ItemId") ?? string.Empty,
    requiredCount = IntProperty(item, "RequiredCount"),
    invalidCountMessage = StringProperty(item, "InvalidCountMessage") ?? string.Empty,
}).ToArray();
static object[] QuantityModifiersWithShape(object? owner, string memberName, string path, List<string> shapeFailures, List<object> shapeEvidence) => CollectionValues(owner, memberName, path, shapeFailures, shapeEvidence).Select(item => (object)new
{
    id = StringProperty(item, "Id") ?? string.Empty,
    condition = StringProperty(item, "Condition") ?? string.Empty,
    modification = StringProperty(item, "Modification") ?? string.Empty,
    amount = PropertyValue(item, "Amount")?.ToString() ?? string.Empty,
    randomAmount = RawStringValues(PropertyValue(item, "RandomAmount")),
}).ToArray();
static SortedDictionary<string, string> StringPairs(object? value)
{
    var result = new SortedDictionary<string, string>(StringComparer.Ordinal);
    if (value is IDictionary dictionary)
        foreach (DictionaryEntry entry in dictionary)
            result[entry.Key?.ToString() ?? "<null>"] = entry.Value?.ToString() ?? "<null>";
    return result;
}
static SortedDictionary<string, string> StringPairsWithShape(object? owner, string memberName, string path, List<string> shapeFailures, List<object> shapeEvidence)
{
    var resolution = ResolveMember(owner, memberName);
    if (resolution.Value is null && IsAllowlistedOptionalCollection(memberName, resolution))
    {
        shapeEvidence.Add(new { path, status = "documented_absent", member = memberName, declaredType = resolution.DeclaredType!.FullName, sourceOptional = true, runtimeType = (string?)null });
        return new SortedDictionary<string, string>(StringComparer.Ordinal);
    }
    if (!resolution.Found) { shapeFailures.Add($"{path}:missing_member"); return new SortedDictionary<string, string>(StringComparer.Ordinal); }
    if (resolution.Value is null) { shapeFailures.Add($"{path}:nonnullable_null"); return new SortedDictionary<string, string>(StringComparer.Ordinal); }
    if (!IsSupportedDeclaredCollection(memberName, resolution.DeclaredType) || resolution.Value is not IDictionary) { shapeFailures.Add($"{path}:unsupported_shape:{resolution.Value.GetType().FullName ?? resolution.Value.GetType().Name}"); return new SortedDictionary<string, string>(StringComparer.Ordinal); }
    return StringPairs(resolution.Value);
}
static string Digest(IEnumerable<string> entries)
{
    string input = string.Join("\n", entries) + "\n";
    return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant();
}

sealed record MemberResolution(bool Found, MemberInfo? Member, Type? DeclaredType, bool SourceOptional, object? Value);

sealed class ServiceProviderStub : IServiceProvider
{
    public object? GetService(Type serviceType) => null;
}
