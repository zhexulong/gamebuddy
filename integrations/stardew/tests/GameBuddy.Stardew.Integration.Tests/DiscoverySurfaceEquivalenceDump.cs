using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A one-off EQUIVALENCE INSTRUMENT, not a gate: it calls every `Discover*` method the controller
/// declares against a fixture world populated for each family in turn, and writes a canonical,
/// order-preserving rendering of each result to a file. Run it before and after a refactor and diff
/// the two files: a member whose rows, ids, tiles or ORDER changed shows up as a diff.
///
/// The tag comes from `GAMEBUDDY_DISCOVERY_DUMP`; without it the case returns immediately, so the
/// suite is unaffected when nobody is comparing.
/// </summary>
public sealed class DiscoverySurfaceEquivalenceDump
{
    /// <summary>The families `TargetFamilyWorld.PopulateFor` can build, plus the bare world.</summary>
    private static readonly string[] Families =
    {
        "bare",
        "treeChopSourceTargets",
        "treeStumpTargets",
        "weedTargets",
        "rockSourceTargets",
        "debrisTargets",
        "grassTargets",
        "chests",
        "npcRelationshipTargets",
        "cropTargets",
        "harvestTargets",
        "seedTargets",
        "itemTargets",
        "forageTargets",
        "warps",
        "toolSlots",
        "clearHoeDirtTargets",
        "scytheCropTargets",
        "shakeTreeTargets",
        "bushTargets",
        "petTargets",
    };

    [Fact]
    public void EveryDeclaredDiscoveryRendersItsResultToTheDump()
    {
        string? tag = Environment.GetEnvironmentVariable("GAMEBUDDY_DISCOVERY_DUMP");
        if (string.IsNullOrWhiteSpace(tag)) return;

        MethodInfo[] discoveries = new[] { typeof(ExecutionManager), typeof(FarmhandTargetDiscovery) }
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Where(method => method.Name.StartsWith("Discover", StringComparison.Ordinal))
            .OrderBy(method => method.Name, StringComparer.Ordinal)
            .ThenBy(Signature, StringComparer.Ordinal)
            .ToArray();

        var report = new StringBuilder();
        var withRows = new List<string>();
        foreach (string family in Families)
        {
            using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
            if (family != "bare") world.PopulateFor(family);
            var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
            var monitor = new DummyMonitor();
            var manager = new ExecutionManager(monitor, () => publication);
            var discovery = manager.TargetDiscovery;

            report.Append("===== family: ").Append(family).AppendLine(" =====");
            foreach (MethodInfo method in discoveries)
            {
                report.Append("### ").Append(method.Name).Append('(');
                ParameterInfo[] parameters = method.GetParameters();
                report.Append(string.Join(", ", parameters.Select(p => $"{SimpleName(p.ParameterType)} {p.Name}")));
                report.AppendLine(")");
                object?[] arguments = parameters.Select(parameter => ArgumentFor(parameter, world)).ToArray();
                try
                {
                    object? target = method.IsStatic ? null : method.DeclaringType == typeof(ExecutionManager) ? manager : discovery;
                    object? result = method.Invoke(target, arguments);
                    foreach (ParameterInfo parameter in parameters.Where(p => p.IsOut))
                        report.Append("out ").Append(parameter.Name).Append(" = ").AppendLine(Format(arguments[parameter.Position], 0));
                    if (Render(result, report, 0) > 0) withRows.Add($"{family}:{method.Name}");
                }
                catch (TargetInvocationException failure)
                {
                    report.Append("THREW ").Append(failure.InnerException?.GetType().Name).Append(": ")
                        .AppendLine(failure.InnerException?.Message);
                }
            }
            report.AppendLine();
        }

        string path = Path.Combine(Path.GetTempPath(), $"gamebuddy-discovery-{tag}.txt");
        File.WriteAllText(path, report.ToString());
        Console.WriteLine($"[discovery-dump] {discoveries.Length} members x {Families.Length} families; "
            + $"{withRows.Distinct(StringComparer.Ordinal).Count()} (family, member) pairs had rows -> {path}");
        Assert.True(discoveries.Length >= 80, $"only {discoveries.Length} Discover* members were reachable");
        Assert.True(withRows.Count >= 40, $"only {withRows.Count} (family, member) pairs produced rows");
    }

    /// <summary>The parameter list as text, so two overloads of one name keep one order in the dump.</summary>
    private static string Signature(MethodInfo method) =>
        string.Join(",", method.GetParameters().Select(p => SimpleName(p.ParameterType)));

    /// <summary>An `out` parameter is an in/out slot; its default is whatever its element type's zero is.</summary>
    private static object? Zero(Type type) => type.IsValueType ? Activator.CreateInstance(type) : null;

    private static object? ArgumentFor(ParameterInfo parameter, TargetFamilyCompletenessTests.TargetFamilyWorld world) =>
        parameter.IsOut ? Zero(parameter.ParameterType.GetElementType()!)
        : parameter.ParameterType == typeof(Farmer) ? world.Actor
        : parameter.ParameterType == typeof(StardewValley.GameLocation) ? world.Farm
        : parameter.ParameterType == typeof(GroundSurface) ? GroundSurface.Of(world.Farm)
        : parameter.ParameterType == typeof(DiscoveryExclusionRecorder) ? new DiscoveryExclusionRecorder()
        : parameter.ParameterType.IsGenericType && parameter.ParameterType.GetGenericTypeDefinition() == typeof(IReadOnlyList<>) ? null
        : parameter.ParameterType == typeof(IList<Item?>) ? world.Actor.Items
        : throw new InvalidOperationException($"no fixture argument for {parameter.Name} of {SimpleName(parameter.ParameterType)}");

    /// <summary>Render one member's result; returns the number of rows it published.</summary>
    private static int Render(object? value, StringBuilder report, int depth)
    {
        if (value is null) { report.AppendLine("null"); return 0; }
        if (value is string text) { report.AppendLine(Quote(text)); return 1; }
        if (value is IEnumerable rows and not string)
        {
            int index = 0;
            foreach (object? row in rows)
            {
                report.Append("  [").Append(index).Append("] ");
                RenderOne(row, report, depth);
                index += 1;
            }
            if (index == 0) report.AppendLine("  (empty)");
            return index;
        }
        RenderOne(value, report, depth);
        return 1;
    }

    private static void RenderOne(object? row, StringBuilder report, int depth)
    {
        if (row is null) { report.AppendLine("null"); return; }
        Type type = row.GetType();
        if (IsScalar(type) || row is string) { report.AppendLine(Format(row, depth)); return; }
        if (row is ValueTuple) { report.AppendLine(Format(row, depth)); return; }
        PropertyInfo[] properties = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => property.GetIndexParameters().Length == 0)
            .OrderBy(property => property.MetadataToken)
            .ToArray();
        if (properties.Length == 0) { report.AppendLine(Quote(row.ToString() ?? "")); return; }
        report.AppendLine(type.Name);
        foreach (PropertyInfo property in properties)
        {
            report.Append(' ', 2 + (depth + 1) * 2).Append(property.Name).Append(" = ");
            object? value;
            try { value = property.GetValue(row); }
            catch (TargetInvocationException failure) { report.AppendLine("THREW " + failure.InnerException?.GetType().Name); continue; }
            if (value is null) { report.AppendLine("null"); continue; }
            if (IsScalar(value.GetType()) || value is string) { report.AppendLine(Format(value, depth)); continue; }
            report.AppendLine();
            Render(value, report, depth + 1);
        }
    }

    private static bool IsScalar(Type type) => type.IsPrimitive || type.IsEnum || type == typeof(decimal);

    private static string Format(object? value, int depth) => value switch
    {
        null => "null",
        bool flag => flag ? "true" : "false",
        string text => Quote(text),
        IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
        _ => value.GetType().IsEnum ? value.ToString()! : Quote(value.ToString() ?? ""),
    };

    private static string Quote(string text) =>
        "\"" + text.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    private static string SimpleName(Type type) => type.IsGenericType
        ? type.Name.Split('`')[0] + "<" + string.Join(", ", type.GetGenericArguments().Select(SimpleName)) + ">"
        : type.Name;
}
