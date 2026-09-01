using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

public sealed class CurrentUserRootLayoutTests
{
    [Fact]
    public async Task DeriveLayout_rejects_reparse_overlap_and_program_root_adoption()
    {
        await using var fixture = await DisposableRootFixture.CreateAsync();
        fixture.ReplaceDataBoundaryWithReparsePoint();

        Assert.Throws<RootLayoutUnavailableException>(() => CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture));

        fixture.RestoreCanonicalBoundaries();
        fixture.MakeDataEqualProgramRoot();

        Assert.Throws<RootLayoutUnavailableException>(() => CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture));
    }

    [Fact]
    public async Task DeriveLayout_rejects_reparse_ancestor_when_the_root_leaf_is_ordinary()
    {
        await using var fixture = await DisposableRootFixture.CreateAsync();
        fixture.ReplaceProgramsAncestorWithReparsePoint();

        Assert.True((File.GetAttributes(fixture.Registration.ProgramRoot) & FileAttributes.ReparsePoint) == 0);
        Assert.Throws<RootLayoutUnavailableException>(() => CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture));
    }

    [Fact]
    public async Task DeriveLayout_accepts_only_the_fixture_canonical_layout_shape()
    {
        await using var fixture = await DisposableRootFixture.CreateAsync();

        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);

        Assert.Equal(fixture.Registration.ProgramRoot, layout.ProgramRoot);
        Assert.Equal(fixture.Registration.DataRoot, layout.DataRoot);
    }

    [Fact]
    public void Layout_is_internal_and_production_entry_accepts_no_root_argument()
    {
        var source = File.ReadAllText(DesktopProgramSource());

        Assert.DoesNotContain("--root", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GAMEBUDDY_ROOT", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.CurrentDirectory", source, StringComparison.Ordinal);
    }

    private static string DesktopProgramSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs"));
}
