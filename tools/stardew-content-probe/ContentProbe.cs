using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

if (args.Length is < 1 or > 2 || (args.Length == 2 && args[1] != "--navigation"))
{
    Console.Error.WriteLine("usage: ContentProbe <game-root> [--navigation]");
    return 2;
}

var navigationOnly = args.Length == 2;
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
    if (navigationOnly)
    {
        Console.WriteLine(JsonSerializer.Serialize(NavigationProjection(root, gameAssembly, dataLoaderType, manager), new JsonSerializerOptions { WriteIndented = false }));
        return 0;
    }

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

static object NavigationProjection(string root, Assembly gameAssembly, Type dataLoaderType, object manager)
{
    object Load(string methodName)
    {
        var method = dataLoaderType.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static, new[] { manager.GetType() })
            ?? throw new InvalidOperationException($"navigation_loader_missing:{methodName}");
        return method.Invoke(null, new[] { manager }) ?? throw new InvalidOperationException($"navigation_loader_null:{methodName}");
    }
    var locations = Load("Locations");
    var worldMap = Load("WorldMap");
    if (locations is not IDictionary locationDictionary || worldMap is not IDictionary mapDictionary)
        throw new InvalidOperationException("navigation_loader_not_dictionary");

    var locationType = DictionaryValueType(locations) ?? throw new InvalidOperationException("location_value_type_missing");
    var regionType = DictionaryValueType(worldMap) ?? throw new InvalidOperationException("world_map_value_type_missing");
    const int characterizationPageSize = 16;
    var locationFields = Shape(locationType);
    var regionFields = Shape(regionType);
    var areaType = MemberType(regionType, "MapAreas")?.GetGenericArguments().SingleOrDefault();
    var tooltipType = areaType is null ? null : MemberType(areaType, "Tooltips")?.GetGenericArguments().SingleOrDefault();
    var positionType = areaType is null ? null : MemberType(areaType, "WorldPositions")?.GetGenericArguments().SingleOrDefault();
    var regions = DictionaryPairs(worldMap).ToArray();
    var allAreas = regions
        .SelectMany(region => EnumerableValues(PropertyValue(region.value, "MapAreas")).Select(area => new { region = region.key, area, areaId = StringProperty(area, "Id") ?? string.Empty }))
        .ToArray();
    var allTooltips = allAreas
        .SelectMany(item => EnumerableValues(PropertyValue(item.area, "Tooltips")).Select(tooltip => new { item.region, item.areaId, tooltip }))
        .ToArray();
    var allPositions = allAreas
        .SelectMany(item => EnumerableValues(PropertyValue(item.area, "WorldPositions")).Select(position => new { item.region, item.areaId, position }))
        .ToArray();
    var mineEntries = DictionaryPairs(locations).Where(entry => string.Equals(entry.key, "Mine", StringComparison.Ordinal)).ToArray();
    var mineData = mineEntries.Length == 1 ? mineEntries[0].value : null;
    var mineDisplayToken = mineData is null ? string.Empty : StringProperty(mineData, "DisplayName") ?? string.Empty;
    var mountainAreas = allAreas.Where(item => item.areaId == "Mountain").ToArray();
    var mountainTooltips = allTooltips.Where(item => item.areaId == "Mountain").ToArray();
    var mines = mountainTooltips.Where(item => string.Equals(StringProperty(item.tooltip, "Id"), "Mines", StringComparison.Ordinal)).ToArray();
    var mineTooltipConditionStates = ConditionStates(mines.Select(item => item.tooltip), "Condition");
    var mineTooltipKnownConditionStates = ConditionStates(mines.Select(item => item.tooltip), "KnownCondition");
    var mineAreaConditionStates = ConditionStates(mountainAreas.Select(item => item.area), "Condition");
    var locationKeys = DictionaryPairs(locations).Select(item => item.key).ToHashSet(StringComparer.Ordinal);
    var directPositionJoins = allPositions.Select(item => DirectLocationJoin(item.position, locationKeys)).ToArray();
    var directlyResolvedLocationKeys = directPositionJoins.Where(item => item.Outcome == "resolved_unique").Select(item => item.LocationIdentity).Where(item => item is not null).Cast<string>().ToHashSet(StringComparer.Ordinal);
    var mapRegionType = gameAssembly.GetType("StardewValley.WorldMaps.MapRegion", throwOnError: false);
    var getLocationName = mapRegionType?.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).SingleOrDefault(method => method.Name == "GetLocationName" && method.GetParameters().Length == 1);
    var inputHashes = new[] { "Stardew Valley.dll", "StardewValley.GameData.dll", "Content/Data/Locations.xnb", "Content/Data/WorldMap.xnb", "Content/ContentHashes.json" }
        .Select(file => new { file, sha256 = File.Exists(Path.Combine(root, file.Replace('/', Path.DirectorySeparatorChar))) ? HashFile(Path.Combine(root, file.Replace('/', Path.DirectorySeparatorChar))) : "missing" })
        .OrderBy(item => item.file, StringComparer.Ordinal)
        .ToArray();
    return new
    {
        artifactKind = "stardew_navigation_p4_redacted_probe",
        schemaVersion = 2,
        gameAssemblyVersion = gameAssembly.GetName().Version?.ToString() ?? string.Empty,
        inputDigest = Digest(inputHashes.Select(item => $"{item.file}\t{item.sha256}")),
        loaders = new { locations = new { state = "loaded", count = locationDictionary.Count }, worldMap = new { state = "loaded", count = mapDictionary.Count } },
        shapes = new { location = locationFields, worldMapRegion = regionFields, worldMapArea = areaType is null ? Array.Empty<string>() : Shape(areaType), worldMapTooltip = tooltipType is null ? Array.Empty<string>() : Shape(tooltipType), worldMapPosition = positionType is null ? Array.Empty<string>() : Shape(positionType) },
        hierarchy = new { regionCount = regions.Length, areaCount = allAreas.Length, tooltipCount = allTooltips.Length, worldPositionCount = allPositions.Length, maxDepth = 3, nodesByDepth = new[] { regions.Length, allAreas.Length, allTooltips.Length, allPositions.Length }, pagination = new { pageSize = characterizationPageSize, rootPageCount = PageCount(regions.Length, characterizationPageSize), maximumAreaChildren = MaximumChildren(regions.Select(region => EnumerableValues(PropertyValue(region.value, "MapAreas")).Count())), maximumTooltipChildren = MaximumChildren(allAreas.Select(area => EnumerableValues(PropertyValue(area.area, "Tooltips")).Count())), maximumPositionChildren = MaximumChildren(allAreas.Select(area => EnumerableValues(PropertyValue(area.area, "WorldPositions")).Count())) } },
        conditions = new { areas = ConditionCounts(allAreas.Select(item => item.area), "Condition"), tooltips = ConditionCounts(allTooltips.Select(item => item.tooltip), "Condition"), knownConditions = ConditionCounts(allTooltips.Select(item => item.tooltip), "KnownCondition") },
        joins = new { directWorldPositionToLocation = JoinCounts(directPositionJoins), tooltipToLocation = new { status = "no_explicit_location_identity_member", candidateCount = 0, resolvedUniqueCount = 0, unresolvedCount = allTooltips.Length, nonUniqueCount = 0 } },
        collisions = new { duplicateRegionKeys = DuplicateCount(regions.Select(item => item.key)), duplicateAreaIdsWithinRegion = DuplicateCount(allAreas.Select(item => $"{item.region}\t{item.areaId}")), duplicateTooltipIdsWithinArea = DuplicateCount(allTooltips.Select(item => $"{item.region}\t{item.areaId}\t{StringProperty(item.tooltip, "Id") ?? string.Empty}")), duplicateLocationKeys = DuplicateCount(DictionaryPairs(locations).Select(item => item.key)), duplicateDirectLocationJoinTargets = DuplicateCount(directPositionJoins.Where(item => item.Outcome == "resolved_unique").Select(item => item.LocationIdentity ?? string.Empty)) },
        leafResolution = new { directResolvedUniqueCount = directlyResolvedLocationKeys.Count, directUnresolvedCount = directPositionJoins.Count(item => item.Outcome == "unresolved"), directNonUniqueCount = directPositionJoins.Count(item => item.Outcome == "nonunique"), contentPresentNotRuntimeEvaluated = true },
        counts = new { mountainAreaCount = mountainAreas.Select(item => $"{item.region}\t{item.areaId}").Distinct(StringComparer.Ordinal).Count(), mountainTooltipCount = mountainTooltips.Length, minesTooltipIdCount = mines.Length },
        mineLineage = new { locationIdentity = mineEntries.Length == 1 ? "Mine" : "missing_or_nonunique", locationDisplayTokenSha256 = Digest(new[] { mineDisplayToken }), displayNameSource = new { tokenPresent = mineDisplayToken.Length > 0, tokenSha256 = Digest(new[] { mineDisplayToken }), currentLocaleResolution = "blocked_requires_runtime_token_parser", fallbackLocaleResolution = "blocked_no_safe_per_locale_target_api_proven" }, mountainBinding = mines.Length == 1 ? "Mountain/Mines" : "missing_or_nonunique", mapRegionGetLocationNameApi = getLocationName is null ? "missing" : "present_static_api_only", currentWorldFact = "blocked_no_game_runtime_or_current_world_instance", sourceJoin = new { regionToMountainAreaMultiplicity = mountainAreas.Length, mountainAreaToMinesTooltipMultiplicity = mines.Length, mineCanonicalLocationInLocations = mineEntries.Length, areaConditionStates = mineAreaConditionStates, tooltipConditionStates = mineTooltipConditionStates, tooltipKnownConditionStates = mineTooltipKnownConditionStates, inclusionState = "content_present_not_runtime_evaluated" } },
        nonClaim = "aggregate/redacted characterization only; no raw labels, tables, coordinates, routes, rectangles, runtime MapRegion invocation, action, ref, bridge, or mutation"
    };
}

static IEnumerable<(string key, object? value)> DictionaryPairs(object dictionary)
    => ((IEnumerable)dictionary).Cast<object>().Select(entry => (entry.GetType().GetProperty("Key")?.GetValue(entry)?.ToString() ?? string.Empty, entry.GetType().GetProperty("Value")?.GetValue(entry)));
static Type? DictionaryValueType(object dictionary)
    => dictionary.GetType().GetInterfaces().Append(dictionary.GetType()).FirstOrDefault(type => type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IDictionary<,>))?.GetGenericArguments()[1];
static Type? MemberType(Type type, string name) => type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance)?.PropertyType ?? type.GetField(name, BindingFlags.Public | BindingFlags.Instance)?.FieldType;
static string[] Shape(Type type) => type.GetMembers(BindingFlags.Public | BindingFlags.Instance).Where(member => member.MemberType is MemberTypes.Field or MemberTypes.Property).Select(member => member.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray();
static string HashFile(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

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
static int PageCount(int count, int pageSize) => count == 0 ? 0 : (count + pageSize - 1) / pageSize;
static int MaximumChildren(IEnumerable<int> counts) => counts.DefaultIfEmpty(0).Max();
static int DuplicateCount(IEnumerable<string> identities)
    => identities.GroupBy(identity => identity, StringComparer.Ordinal).Sum(group => Math.Max(0, group.Count() - 1));
static string ConditionState(object? value, string memberName)
    => StringProperty(value, memberName) is { Length: > 0 } ? "present_not_evaluated" : "absent";
static string[] ConditionStates(IEnumerable<object?> values, string memberName)
    => values.Select(value => ConditionState(value, memberName)).Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
static object ConditionCounts(IEnumerable<object?> values, string memberName)
{
    var states = values.Select(value => ConditionState(value, memberName)).ToArray();
    return new { absent = states.Count(state => state == "absent"), presentNotEvaluated = states.Count(state => state == "present_not_evaluated") };
}
static DirectJoin DirectLocationJoin(object? position, ISet<string> locationKeys)
{
    var candidates = new HashSet<string>(StringComparer.Ordinal);
    var locationName = StringProperty(position, "LocationName");
    if (!string.IsNullOrEmpty(locationName)) candidates.Add(locationName);
    foreach (var candidate in EnumerableValues(PropertyValue(position, "LocationNames")).Select(value => value?.ToString()).Where(value => !string.IsNullOrEmpty(value))) candidates.Add(candidate!);
    var matching = candidates.Where(locationKeys.Contains).OrderBy(value => value, StringComparer.Ordinal).ToArray();
    return matching.Length switch
    {
        0 => new DirectJoin("unresolved", null),
        1 => new DirectJoin("resolved_unique", matching[0]),
        _ => new DirectJoin("nonunique", null),
    };
}
static object JoinCounts(IEnumerable<DirectJoin> joins)
{
    var values = joins.ToArray();
    return new { candidateCount = values.Length, resolvedUniqueCount = values.Count(item => item.Outcome == "resolved_unique"), unresolvedCount = values.Count(item => item.Outcome == "unresolved"), nonUniqueCount = values.Count(item => item.Outcome == "nonunique") };
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
sealed record DirectJoin(string Outcome, string? LocationIdentity);

sealed class ServiceProviderStub : IServiceProvider
{
    public object? GetService(Type serviceType) => null;
}
