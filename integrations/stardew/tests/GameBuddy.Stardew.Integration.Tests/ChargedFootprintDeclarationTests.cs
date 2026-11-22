using System.Globalization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A <c>charge</c> argument is a claim about a RECTANGLE, so every action that accepts one answers for the tiles the
/// rectangle reaches beyond the named tile.
///
/// <para>
/// WHY THIS GATE EXISTS. <c>Tool.tilesAffected</c> is not centred on the named tile: a 3x3 and a 3x6 cover one row either
/// side of it and a 5x5 two rows before it (<c>Tool.cs:972-1072</c>), so one packed row also reaches rows the plan never
/// named. <c>till_soil</c> shipped without checking that rectangle, and a keg standing two tiles from the named tile left
/// the world with no refusal naming it. The repair is one handler's pre-check; the DELIVERABLE is that no future charged
/// action can repeat it.
/// </para>
/// <para>
/// THE POPULATION IS THE CATALOGUE'S OWN REGISTRATIONS, never a list kept here: a row that starts accepting <c>charge</c>
/// and says nothing about its footprint fails by action id, and a row whose declaration claims a pre-check has to show it
/// in the handler that runs it. Zero population is refused rather than green, because a check whose population is empty
/// agrees with itself.
/// </para>
/// </summary>
public sealed class ChargedFootprintDeclarationTests
{
    private const string ModRoot = "integrations/stardew";

    /// <summary>The one call that reads the engine's own rectangle - the pre-check's first statement.</summary>
    private const string FootprintRead = "ChargedFootprint.Tiles(";

    /// <summary>The one native tool swing a pre-check must precede.</summary>
    private const string NativeCall = "UseNativeToolOnTile(";

    [Fact]
    public void EveryActionThatAcceptsAChargeDeclaresWhatItsFootprintDoes()
    {
        List<FarmhandActionRegistration> charged = Charged();

        charged.Should().NotBeEmpty(
            "charged_footprint_population_empty: the population is the catalogue's own registrations, and an empty one would pass this file without examining anything");

        foreach (FarmhandActionRegistration registration in charged)
        {
            FarmhandChargedFootprintDeclaration? declaration = registration.Descriptor!.ChargedFootprint;
            declaration.Should().NotBeNull($"charged_footprint_unchecked:{registration.ActionId}");
            if (declaration!.Prechecked)
            {
                declaration.Reason.Should().BeNull(
                    $"charged_footprint_unchecked:{registration.ActionId}: a pre-checked footprint needs no exemption, and stating one would say two things at once");
                continue;
            }

            declaration.Reason.Should().Be(
                FarmhandChargedFootprintDeclaration.NonDestructive,
                $"charged_footprint_unchecked:{registration.ActionId}: a footprint that is not pre-checked states the one reason the gate accepts, with its engine citation");
        }
    }

    /// <summary>
    /// A CHARGE ABOVE ZERO IS AIMED BY THE FACING, so the body must stand on one of the four axes - and the row must SAY
    /// so: <c>Tool.tilesAffected</c> builds its rectangle from <c>who.FacingDirection</c> (<c>Tool.cs:919</c>), a diagonal
    /// tile is on no axis a tool can point down, and the body refuses that with <c>charge_needs_cardinal_stance</c>.
    ///
    /// <para>
    /// WHY THIS IS A GATE AND NOT A ONE-OFF EDIT. `till_soil` admitted a request from any of the eight neighbours and
    /// refused the diagonal inside its own body, so the companion learned the geometry only by being refused after a walk -
    /// the class `round92` recorded for `sweep_scythe`, repeated one tool family over. The population is the catalogue's own
    /// <c>charge</c> rows, so the next charged action fails here by name instead of in a live run.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryActionThatAcceptsAChargeDeclaresTheCardinalStanceItsFootprintNeeds()
    {
        List<FarmhandActionRegistration> charged = Charged();
        charged.Should().NotBeEmpty("charged_stance_undeclared:none: the population is the catalogue's own `charge` rows");

        List<string> undeclared = charged
            .Where(registration => registration.Descriptor!.Approach is not { Stance: ApproachStance.Cardinal })
            .Select(registration => registration.ActionId)
            .ToList();

        undeclared.Should().BeEmpty(
            "charged_stance_undeclared: one charged use aims its rectangle along the facing (Tool.cs:919), so the tile it is\n"
            + "aimed at must be a cardinal neighbour and the row must declare `SelfWalked(..., ApproachStance.Cardinal)` - "
            + "otherwise the request is admitted from a diagonal and refused after the walk: "
            + string.Join(", ", undeclared));
    }

    [Fact]
    public void APrecheckedFootprintIsTheOneTheHandlerWalks()
    {
        List<string> prechecked = Charged()
            .Where(registration => registration.Descriptor!.ChargedFootprint is { Prechecked: true })
            .Select(registration => registration.ActionId)
            .ToList();

        prechecked.Should().NotBeEmpty(
            "charged_footprint_unchecked:none: a declaration nothing proves is decoration, and this file would be an empty ritual");

        foreach (string actionId in prechecked)
        {
            // THE DECLARATION IS A CLAIM ABOUT CODE, so it is read against the code: the handler method that names the
            // action must read the engine's rectangle BEFORE the charged native call it guards. A guard placed after the
            // swing would refuse nothing the swing had not already done.
            List<string> handlers = HandlerBodies(actionId);

            handlers.Should().ContainSingle(
                $"charged_footprint_unchecked:{actionId}: one handler both names the action and makes the charged native call, and exactly one method must carry the pre-check");
            string handler = handlers[0];
            int seam = handler.IndexOf(NativeCall, StringComparison.Ordinal);
            seam.Should().BeGreaterThanOrEqualTo(
                0,
                $"charged_footprint_unchecked:{actionId}: the guarded native call must sit in the same method as the pre-check");
            handler.IndexOf(FootprintRead, StringComparison.Ordinal).Should().BeLessThan(
                seam,
                $"charged_footprint_unchecked:{actionId}: the rectangle must be read BEFORE the swing, or the refusal arrives after the world changed");
        }
    }

    /// <summary>Every registration whose descriptor declares a <c>charge</c> argument: the footprint is that argument.</summary>
    private static List<FarmhandActionRegistration> Charged() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is not null)
            .Where(registration => registration.Descriptor!.Arguments.Any(argument =>
                string.Equals(argument.Name, "charge", StringComparison.Ordinal)))
            .ToList();

    /// <summary>
    /// The Mod methods that mention <paramref name="actionId"/> AND call the charged native seam - the one method per
    /// pre-checked action that both owns the action and performs its swing.
    /// </summary>
    private static List<string> HandlerBodies(string actionId)
    {
        var bodies = new List<string>();
        foreach (string file in ModSourceFiles())
        {
            string source = File.ReadAllText(file);
            int cursor = -1;
            while ((cursor = source.IndexOf(FootprintRead, cursor + 1, StringComparison.Ordinal)) >= 0)
            {
                string body = MethodAround(source, cursor);
                if (body.Contains($"\"{actionId}\"", StringComparison.Ordinal)
                    && body.Contains(NativeCall, StringComparison.Ordinal))
                    bodies.Add(body);
            }
        }
        return bodies;
    }

    /// <summary>
    /// The method body containing <paramref name="marker"/>, found by walking back to its signature and then forward to
    /// the brace that closes it - the same brace walk `AreaToolFootprintTests` uses, applied from the call site outward
    /// because the pre-check's own caller is what this gate is about.
    /// </summary>
    private static string MethodAround(string source, int marker)
    {
        int signature = source.LastIndexOf("\n    private ", marker, StringComparison.Ordinal);
        signature.Should().BeGreaterThanOrEqualTo(0, "the pre-check must sit inside a method of the handler");
        int opening = source.IndexOf('{', source.IndexOf('(', signature));
        opening.Should().BeGreaterThanOrEqualTo(0, "the method that holds the pre-check must have a body");
        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0) return source[opening..(position + 1)];
        }
        throw new InvalidOperationException(
            string.Create(CultureInfo.InvariantCulture, $"the method around offset {marker} has an unbalanced body"));
    }

    /// <summary>Every shipped Mod source, so the pre-check is found wherever it lands.</summary>
    private static IEnumerable<string> ModSourceFiles() =>
        Directory.GetFiles(RepositorySourcePath(ModRoot), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}action-development{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }

    private static string RepositorySourcePath(string relative) => Path.Combine(RepositoryRoot(), relative);
}
