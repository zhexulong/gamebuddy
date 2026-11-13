using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The falsifier for the two `dotnet test` gates - `test:stardew:core` and `test:stardew:integration`.
///
/// <para>
/// WHAT IT PROVES. Each of those gates is one command, `dotnet test &lt;project&gt;`, so the only violation that
/// can make it exit non-zero is a fact inside that project that fails. This test derives a probe project from the
/// real `.csproj` - the same package and project references, the same analyzer and warning policy, every source
/// the real project compiles - adds one injected failing fact and one passing fact, runs the same `dotnet test`
/// the gate runs, and asserts the runner's own lines: the failing fact named as `Failed`, the summary reading
/// `Failed: 1, Passed: 1`, and a non-zero exit. The passing fact is the control: a configuration that reported
/// every fact as failed would satisfy the exit code and the name and not the summary.
/// </para>
/// <para>
/// WHY THE PROJECT IS DERIVED AND THE FAILING FACT IS NOT IN THE REPOSITORY. The gate has to stay green here, so
/// the injected source is written to a temporary directory and the real project file is rewritten beside it. No
/// compile item and no reference is copied by hand: the sources come from the real project's own directory and
/// the references from its own `ProjectReference` elements, so a file added to the suite, a reference added to its
/// csproj or a project that stops being a test project is inside the probe the day it lands.
/// </para>
/// <para>
/// WHAT IT DOES NOT PROVE. That the real suite's facts pass. That is the gate's own green reading and the run that
/// contains this test; asserting it here would fail this falsifier for any unrelated failing fact instead of
/// naming the injected one. It also does not prove that a fact whose body was deleted is still discovered - only
/// that a discovered fact that fails is reported as failed and exits non-zero.
/// </para>
/// <para>
/// ONE GATE NEEDS THE GAME, AND ITS FACT IS SKIPPED THERE RATHER THAN PASSED. The integration project references
/// the Mod, whose build package refuses before the compiler runs when the machine holds no licensed game folder
/// (`Pathoschild.Stardew.ModBuildConfig.targets`: "The mod build package can't find your game folder"), so its
/// probe cannot build and the injected fact is never reported. That is a missing prerequisite, not a failing fact:
/// a skipped fact says "not measured" while a passing one would say "measured, and clean", and the second reading
/// is the one this lane must never produce for a gate it did not run. The skip is decided by
/// <see cref="GameFolderFactAttribute"/> on the Mod build package's own verdict, so the game path is not spelled a
/// second time here, and it covers only that one refusal - a missing SMAPI, a broken import or any other build
/// failure leaves the fact running, and it then fails on the runner's own lines.
/// </para>
/// <para>
/// The injected facts live in <see cref="ProbeNamespace"/> and each run is filtered to it, which is also what
/// keeps the integration probe from recursing: it compiles this file, and the nested run never executes it.
/// </para>
/// </summary>
public sealed class SuiteRedProofTests
{
    /// <summary>The two gates whose whole rule is one `dotnet test` exit code, and the project each one runs.</summary>
    private const string CoreProject = "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests";

    private const string IntegrationProject = "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests";

    private const string ProbeNamespace = "GameBuddy.Stardew.SuiteRedProofProbe";

    private const string FailingFact = ProbeNamespace + ".InjectedFacts.AnInjectedFailingFact";

    [Fact]
    public void TheCoreSuiteGateGoesRedForAFactThatFails()
    {
        AssertGateReportsTheInjectedFailure(CoreProject);
    }

    [GameFolderFact]
    public void TheIntegrationSuiteGateGoesRedForAFactThatFails()
    {
        AssertGateReportsTheInjectedFailure(IntegrationProject);
    }

    private static void AssertGateReportsTheInjectedFailure(string projectDirectory)
    {
        string projectPath = Path.Combine(RepositoryRoot(), projectDirectory.Replace('/', Path.DirectorySeparatorChar));
        string projectFile = Directory
            .GetFiles(projectPath, "*.csproj")
            .Should()
            .ContainSingle($"{projectDirectory} is the project the gate's command names, so it must hold exactly one csproj")
            .Subject;

        string work = Path.Combine(Path.GetTempPath(), "gamebuddy-suite-red-proof-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            File.WriteAllText(Path.Combine(work, "InjectedFacts.cs"), InjectedFactsSource());
            File.WriteAllText(Path.Combine(work, "Probe.csproj"), DerivedProjectFile(projectFile, projectPath));

            ProcessResult result = RunDotnet(
                work,
                "test",
                Path.Combine(work, "Probe.csproj"),
                "--filter",
                "FullyQualifiedName~" + ProbeNamespace);

            result.ExitCode.Should().NotBe(
                0,
                "the gate is `dotnet test {0}`, so a failing fact in it must exit non-zero. Runner output:\n{1}",
                projectDirectory,
                result.Output);

            result.Output.Should().Contain(
                "Failed " + FailingFact,
                "the runner must name the fact it reported as failed, or the red line names the rule and not the member. Runner output:\n"
                    + result.Output);

            result.Output.Should().MatchRegex(
                @"Failed!\s+-\s+Failed:\s+1,\s+Passed:\s+1,",
                "the runner's summary must report one failed fact beside the one passing control fact. Runner output:\n"
                    + result.Output);
        }
        finally
        {
            Directory.Delete(work, true);
        }
    }

    /// <summary>
    /// The real project file, with its relative includes resolved and the real project's sources compiled into the
    /// probe. Everything else - target framework, packages, analyzer policy, references - is the file the gate's
    /// project already has, which is what makes the probe a reading of that project rather than a replica.
    /// </summary>
    private static string DerivedProjectFile(string projectFile, string projectDirectory)
    {
        string mine = Path.GetFullPath(projectDirectory).Replace('\\', '/');
        string derived = Regex.Replace(
            File.ReadAllText(projectFile),
            "(<(?:ProjectReference|Compile|None|Content) Include=\")([^\"]+)(\")",
            match =>
            {
                string include = match.Groups[2].Value;
                bool resolved = include.Contains("$(", StringComparison.Ordinal) || Path.IsPathRooted(include);
                return resolved
                    ? match.Value
                    : match.Groups[1].Value + Path.GetFullPath(Path.Combine(projectDirectory, include.Replace('\\', '/'))) + match.Groups[3].Value;
            });

        int closing = derived.LastIndexOf("</Project>", StringComparison.Ordinal);
        closing.Should().BeGreaterThan(0, $"{projectFile} must be a project file with a closing element");
        string sources =
            $"  <ItemGroup>\n"
            + $"    <Compile Include=\"{mine}/**/*.cs\" Exclude=\"{mine}/obj/**/*.cs;{mine}/bin/**/*.cs\" />\n"
            + "  </ItemGroup>\n";
        return derived.Insert(closing, sources);
    }

    /// <summary>
    /// Two facts in one class: xunit assembles facts of one class sequentially, so the two nested builds this test
    /// starts never race over the real projects' intermediate output.
    /// </summary>
    private static string InjectedFactsSource()
    {
        List<string> lines = new()
        {
            "using Xunit;",
            "",
            "namespace " + ProbeNamespace + ";",
            "",
            "public sealed class InjectedFacts",
            "{",
            "    [Fact]",
            "    public void AnInjectedFailingFact()",
            "    {",
            @"        Assert.Fail(""injected: the red proof for the dotnet test gate"");",
            "    }",
            "",
            "    [Fact]",
            "    public void AnInjectedPassingFact()",
            "    {",
            "    }",
            "}",
        };
        return string.Join(Environment.NewLine, lines) + Environment.NewLine;
    }

    /// <summary>
    /// The gate's own command shape, with the runner forced to English so its summary line is the same string in
    /// every locale: the assertion is on that line, and a localized runner would read as a missing one.
    /// </summary>
    private static ProcessResult RunDotnet(string workingDirectory, params string[] arguments)
    {
        ProcessStartInfo start = new("dotnet")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
            start.ArgumentList.Add(argument);
        start.Environment["DOTNET_CLI_UI_LANGUAGE"] = "en";
        start.Environment["VSLANG"] = "1033";

        StringBuilder output = new();
        using Process process = new() { StartInfo = start };
        process.OutputDataReceived += (_, eventArgs) => Append(output, eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => Append(output, eventArgs.Data);
        process.Start().Should().BeTrue("`dotnet` must start: the gate's rule is this runner's exit code");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        bool exited = process.WaitForExit(10 * 60 * 1000);
        if (!exited)
        {
            process.Kill(true);
            string timedOut = output.ToString();
            throw new InvalidOperationException("dotnet did not finish inside ten minutes. Output:\n" + timedOut);
        }

        process.WaitForExit();
        lock (output)
            return new ProcessResult(process.ExitCode, output.ToString());
    }

    private static void Append(StringBuilder output, string? line)
    {
        if (line is null) return;
        lock (output) output.AppendLine(line);
    }

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    private sealed record ProcessResult(int ExitCode, string Output);

    /// <summary>
    /// <c>[Fact]</c> for a gate whose project cannot even build where no game is installed, reported as SKIPPED with
    /// its reason instead of passing with nothing measured.
    ///
    /// <para>
    /// The prerequisite is asked of the Mod's own build package - its <c>BeforeBuild</c> target, the one carrying the
    /// <c>&lt;Error&gt;</c> lines - rather than re-deriving the game path here, which would be a second copy of a fact
    /// the package already owns. Only its missing-game-folder refusal skips; every other outcome, including a build
    /// failure for another reason, leaves the skip unset so the fact runs and answers for itself.
    /// </para>
    /// </summary>
    public sealed class GameFolderFactAttribute : FactAttribute
    {
        private const string MissingGameFolderRefusal = "The mod build package can't find your game folder";

        public GameFolderFactAttribute()
        {
            if (MissingGameFolder() is string skip) Skip = skip;
        }

        private static string? MissingGameFolder()
        {
            try
            {
                string project = Path.Combine(RepositoryRoot(), "integrations", "stardew", "GameBuddy.Stardew.csproj");
                ProcessResult result = RunDotnet(
                    Path.GetDirectoryName(project)!,
                    "msbuild",
                    project,
                    "-t:BeforeBuild",
                    "-nologo",
                    "-v",
                    "q");
                return result.ExitCode != 0 && result.Output.Contains(MissingGameFolderRefusal, StringComparison.Ordinal)
                    ? "not measured: game folder absent"
                    : null;
            }
            catch (Exception)
            {
                // Discovery runs this constructor for every fact in the assembly, so a throw here would take the
                // whole suite down. Leaving the skip unset runs this one fact, which fails by name on the same cause.
                return null;
            }
        }
    }
}
