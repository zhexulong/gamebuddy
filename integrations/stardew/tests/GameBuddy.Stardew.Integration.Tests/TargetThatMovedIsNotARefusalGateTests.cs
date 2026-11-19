using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE: no action whose request names a target identity may answer "the target is no longer where you named it"
/// with a refusal, unless the register below says why that refusal is the right answer.
///
/// <para>
/// WHY. Measured `round77`: eight <c>break_rock</c> nodes answered <c>rock_target_changed</c> for eight tiles the world
/// had ALREADY cleared - seven of them broken by the preceding settlement nine seconds earlier (timeline 402-408, then
/// 409-415) and the eighth four facts after its own swing (514, 518). Each refusal cost a node of a plan that then went
/// on to succeed. The same shape appeared once on the modal side: <c>respond_level_up</c> refused
/// <c>modal_not_level_up</c> for a <c>LevelUpMenu</c> an earlier settlement had already closed. Both are one defect
/// family: a request armed against a world that had moved on, answered as if the caller had asked for something wrong.
/// </para>
///
/// <para>
/// THE PROPERTY. An action that names a target identity must answer a target that is not at the named address with
/// something a caller can act on: it either SETTLES it (the state the request asked for already holds, so the terminal
/// is the outcome and no walk happens - <c>TileTargetGate.Settled</c>), or it names the absence SEPARATELY from a changed
/// identity (<c>*_target_gone</c> / <c>*_target_not_found</c> / <c>*_target_unavailable</c>), or it does not refuse on
/// the target at all. What it may not do is answer one word - <c>*_target_changed</c> / <c>*_target_moved</c> - for both
/// "there is nothing there" and "a different thing stands there", because those two tell the caller different things:
/// the first means the work at that address is done, the second means re-observe before trying again.
/// </para>
///
/// <para>
/// POPULATION, from the catalogue and the handler arms, never from a list here: every registered EXECUTION action whose
/// request half (the <c>RequestLocal*</c> method its own handler <c>switch</c> arm names) declares an
/// <c>expectedTargetId</c> parameter. That is what "the request names a target identity" means on the wire. An arm that
/// resolves to no readable request half fails the gate rather than shrinking it.
/// </para>
///
/// <para>
/// THE REGISTER, AND WHAT IT IS ALLOWED TO SAY. A member of the population that still refuses on a target that moved is
/// either <b>legitimate</b> - for that action a gone target really is the failure, because the action's own success is
/// the thing being there - or <b>collapses-two-facts</b>, which is debt rather than a decision: the action's success
/// takes the addressed row out of the world (the catalogue's own <c>FarmhandChoreDeclaration.Consumes</c> says
/// so), so "nothing is there" is the state its own work produces, and one code for both facts hides which happened. Each
/// entry is one line, and the KIND is not the author's choice: it is derived from that declaration and the gate fails an
/// entry filed under the other one. Every entry expires - an action that starts settling, or whose file stops refusing
/// on the target, fails the gate naming the row to delete - so the register cannot outlive the defect it records.
/// </para>
///
/// <para>
/// WHAT IT READS, and therefore what it can miss: it is a source-shape gate over the request path (the request half plus
/// every member of the same partials it delegates to). It proves the ANSWER VOCABULARY, not the live behaviour; that is
/// driven for the rock family in <c>RockSourceAlreadyGoneTests</c> and <c>pickup_item</c>/<c>pickup_forage</c> in
/// <c>PickupRetriesATileTheItemHasLeftTests</c>.
/// </para>
/// </summary>
public sealed class TargetThatMovedIsNotARefusalGateTests
{
    private const string ModDirectory = "integrations/stardew";
    private const string HandlersDirectory = "integrations/stardew/Handlers";

    /// <summary>
    /// The actions whose answer to a target that is no longer at the named address IS a refusal, and why that is the
    /// right answer: the action's own success is the thing being there, so a gone target is the request's failure and
    /// not a state its work produces.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> LegitimateRefusals = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["accept_daily_quest"] = "the offer has to still be on the board: an accepted quest cannot be un-taken, so an offer the board no longer lists is the request's failure and not its outcome",
        ["accept_special_order"] = "the order has to still be on the board: the request's own success is the acceptance, and an order that left the board cannot be accepted",
        ["build_farm_building"] = "the site the build was bound to has to still be that site: the game places a building once, and a site that is gone has no placement left to make",
        ["claim_mail_attachment"] = "the letter has to still be in the mailbox: an attachment is claimed by opening that letter, and a mailbox without it has nothing to open",
        ["claim_museum_reward"] = "the reward has to still be unclaimed in the museum's own set: a set that no longer offers it is not a reward this request can claim",
        ["clear_cask"] = "the cask has to still be standing on the tile: clearing it moves its contents into the pack, and a gone cask took them with it",
        ["deposit_silo_hay"] = "the silo has to still be there to receive the hay: a stack deposited into nothing leaves the pack unchanged",
        ["dress_mannequin"] = "the mannequin has to still be standing on the tile: dressing it writes that piece's own slots, and a gone mannequin has none",
        ["fish_here"] = "the water has to still be water where the caller named it: a cast into a tile that is no longer fishable is not a fishing attempt",
        ["machine_collect_output"] = "the machine has to still be standing: the output this action collects is held by that machine, and a gone machine holds nothing",
        ["machine_inspect"] = "the machine has to still be standing: the inspection reads its own fields, and there is nothing to read at an empty tile",
        ["machine_load"] = "the machine has to still be standing to receive the input: an input placed into nothing leaves the pack unchanged",
        ["place_owned_object"] = "the carried piece has to still be in the pack: the identity this request names IS the piece, and a piece that left the pack cannot be placed",
        ["refill_watering_can"] = "the water source has to still be there: the can is refilled by that tile's water, and a tile that is no longer water refills nothing",
        ["ride_minecart"] = "the station has to still be at the stop the request named: the ride starts from it, and a stop with no station starts nothing",
        ["set_sign_display"] = "the sign has to still be standing: the display writes the item onto that sign's own text, and a gone sign has no text to write",
        ["ship_item"] = "the shipping bin has to still be standing: a shipped stack is received by the bin, and a gone bin receives nothing",
        ["take_pedestal_item"] = "the pedestal has to still hold the item: taking is the removal of what stands on it, and a gone pedestal holds nothing",
        ["toggle_fence_gate"] = "the fence gate has to still be standing: the toggle writes that gate's own open flag, and a gone gate has no flag",
        ["withdraw_silo_hay"] = "the silo has to still be there and hold hay: withdrawing takes a hay stack out of it, and a gone silo has none to give",
    };

    /// <summary>
    /// The actions that answer both "nothing is there" and "a different thing is there" with one code, filed as DEBT:
    /// each one's own success takes the addressed row out of the world (<c>FarmhandChoreDeclaration.Consumes</c>), so the
    /// absent case is a state that action produces and the caller must be able to tell it from a changed identity. The
    /// value is the absence name the action should gain - a code, not permission.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> CollapsesTwoFacts = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["break_resource_clump"] = "clump_target_gone",
        ["chop_stump"] = "stump_target_gone",
        ["chop_tree"] = "tree_chop_source_gone",
        ["clear_debris"] = "debris_target_gone",
        ["clear_hoedirt"] = "clear_hoedirt_target_gone",
        ["collect_crab_pot_output"] = "crab_pot_output_gone",
        ["cut_grass"] = "grass_target_gone",
        ["cut_weeds"] = "weed_target_gone",
        ["dig_artifact_spot"] = "artifact_spot_gone",
        ["feed_animal"] = "feed_trough_target_gone",
        ["harvest_bush"] = "bush_fruit_gone",
        ["harvest_fruit_tree"] = "fruit_tree_fruit_gone",
        ["shake_tree"] = "shake_tree_target_gone",
        ["water_slime_hutch_trough"] = "slime_hutch_trough_target_gone",
    };

    private static readonly Regex MemberDeclaration = new(
        @"^[ \t]*(?:(?:private|internal|public|protected|static|sealed|override|partial|async|readonly|unsafe)\s+)+[\w<>?,\[\]\.\s]+?\s(?<name>\w+)\s*\((?<parameters>[^;{]*)\)\s*(?<open>=>|\{)",
        RegexOptions.Multiline | RegexOptions.CultureInvariant);

    private static readonly Regex HandlerArm = new(
        @"""(?<action>[a-z0-9_]+)""\s*=>\s*this\.executions\.(?<method>RequestLocal\w+)\(",
        RegexOptions.CultureInvariant);

    /// <summary>The refusal codes that say "the target is not what you remembered" - the words this gate is about.</summary>
    private static readonly Regex ChangeCode = new(@"(?:_target_(?:changed|moved)|^target_changed)$", RegexOptions.CultureInvariant);

    /// <summary>The codes that name absence as its own fact, so a caller can tell "gone" from "a different thing".</summary>
    private static readonly Regex AbsenceCode = new(@"(?:_target_(?:gone|not_found|unavailable)|^nothing_to_|_already_answered)$", RegexOptions.CultureInvariant);

    /// <summary>The one seam a gate uses to answer that the request's own outcome already holds.</summary>
    private const string SettlementMarker = "TileTargetGate.Settled(";

    private readonly ITestOutputHelper output;

    public TargetThatMovedIsNotARefusalGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// THE LINE: <c>actions examined A · re-resolve or settle R · refuse-on-move F · register { legitimate L,
    /// collapses-two-facts C }</c>. <c>F</c> must be zero: the registered refusals are decisions a reader can audit, and
    /// anything outside them is an action that would spend a caller's turn on a world that already moved.
    /// </summary>
    [Fact]
    public void EveryIdentityNamingActionAnswersAMissingTargetWithSomethingOtherThanARefusal()
    {
        Census census = Measure();

        census.Unresolved.Should().BeEmpty(
            "an action whose handler arm resolves to no readable request half is an action this gate cannot read, and the "
                + "census below would shrink while still reporting no refusals:\n  " + string.Join("\n  ", census.Unresolved));
        census.Rows.Should().NotBeEmpty("the catalogue declares execution actions that name a target identity");

        List<Row> refusers = census.Refusers();
        List<Row> unregistered = refusers.Where(row => !Registered(row.ActionId)).ToList();
        this.Print(census, refusers, unregistered);

        IReadOnlyList<string> population = census.Rows.Select(row => row.ActionId).ToList();
        foreach (string actionId in LegitimateRefusals.Keys.Concat(CollapsesTwoFacts.Keys))
            population.Should().Contain(actionId,
                $"{actionId} is in the register but no longer names a target identity, so its entry has nothing left to excuse");
        LegitimateRefusals.Keys.Should().NotIntersectWith(CollapsesTwoFacts.Keys, "one action cannot be filed under both kinds");

        // EVERY ENTRY EXPIRES. A registered action that now settles, names its absence, or stops refusing on the target
        // is an entry that has outlived the defect it recorded, so it is deleted rather than left standing.
        List<Row> expired = new();
        foreach (string actionId in LegitimateRefusals.Keys.Concat(CollapsesTwoFacts.Keys))
            if (census.Rows.SingleOrDefault(row => row.ActionId == actionId) is { } row && !row.RefusesOnATargetThatMoved)
                expired.Add(row);
        expired.Select(row => $"{row.ActionId} ({row.RequestHalf})").Should().BeEmpty(
            "these register entries have expired - the action now answers a missing target without that refusal - so the "
                + "row must be DELETED from the register, not kept as a standing exemption: delete "
                + string.Join(", ", expired.Select(row => row.ActionId)));

        // THE KIND IS DERIVED, NOT FILED. A consuming action's absence is a state its own work produces; a
        // non-consuming one's success needs the subject present.
        List<string> misfiled = new();
        foreach ((string actionId, string reason) in LegitimateRefusals)
        {
            if (Consumes(actionId)) misfiled.Add($"{actionId}: the catalogue says its work consumes the addressed row, so a gone target is that work's own outcome - file it under collapses-two-facts with the absence code it should gain");
            else if (reason.Length <= 40) misfiled.Add($"{actionId}: the reason is a word, not a sentence that makes absence the failure");
        }
        foreach ((string actionId, string absenceCode) in CollapsesTwoFacts)
        {
            if (!Consumes(actionId)) misfiled.Add($"{actionId}: the catalogue says its subject survives the work, so a gone target really is its failure - file it under legitimate with the sentence that says why");
            else if (!Regex.IsMatch(absenceCode, "^[a-z][a-z0-9_]*_(?:gone|not_found|unavailable)$", RegexOptions.CultureInvariant))
                misfiled.Add($"{actionId}: '{absenceCode}' is not an absence code - name the code the action should gain");
        }
        misfiled.Should().BeEmpty("the register's kind is decided by the catalogue, and its content is a decision a reader can act on:\n  " + string.Join("\n  ", misfiled));

        unregistered.Select(row => $"{row.ActionId} ({row.RequestHalf}) refuses on a target that moved: {string.Join(", ", row.ChangeCodes)}").Should().BeEmpty(
            "these actions answer \"there is nothing there\" and \"a different thing stands there\" with one refusal, so a "
                + "caller cannot tell a world that already did the work from one it must re-observe. Settle it through "
                + "`TileTargetGate.Settled`, name the absence separately, or file the row in the register with the reason:\n  "
                + string.Join("\n  ", unregistered.Select(row => $"{row.ActionId}: {string.Join(", ", row.ChangeCodes)}")));
    }

    /// <summary>
    /// THE FALSIFIER, on the real history: with the rock path's settlement stripped out, the same census finds
    /// <c>break_rock</c> in the unregistered set, naming <c>rock_target_changed</c> - which is exactly the receipt
    /// `round77` minted eight times. A gate that cannot go red on the defect it was written for is a gate nobody has
    /// read.
    /// </summary>
    [Fact]
    public void TheCensusIsRedOnTheRockPathBeforeItSettled()
    {
        Census before = Measure(edit: (file, text) =>
            file.EndsWith("farmhandexecutioncontroller.resourcetoolactions.cs", StringComparison.Ordinal)
                ? text.Replace(SettlementMarker, "TileTargetGate.Refused(", StringComparison.Ordinal)
                : text);

        Row rock = before.Rows.Should().ContainSingle(row => row.ActionId == "break_rock").Subject;
        rock.RefusesOnATargetThatMoved.Should().BeTrue(
            "without the settlement the rock path answers a gone rock with `rock_target_changed`, which is what round77 minted");
        rock.ChangeCodes.Should().Contain("rock_target_changed");
        before.Refusers().Should().Contain(row => row.ActionId == "break_rock",
            "the census must name the action, not merely count it");
    }

    // -----------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The population, its answers and the rows this process could not read.
    ///
    /// <paramref name="edit"/> rewrites one file's source before it is indexed, so the falsifier can drive the same
    /// census over the tree as it stood before a fix without keeping a second copy of the reading.
    /// </summary>
    private static Census Measure(Func<string, string, string>? edit = null)
    {
        Dictionary<string, (string Parameters, string Body)> members = MemberBodies(edit);
        Dictionary<string, string> arms = HandlerArms(edit);
        List<Row> rows = new();
        List<string> unresolved = new();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Kind != FarmhandOperationKind.Execution) continue;
            if (!arms.TryGetValue(registration.ActionId, out string? half)) continue;
            if (!members.TryGetValue(half, out (string Parameters, string Body) member))
            {
                unresolved.Add($"{registration.ActionId} -> {half}");
                continue;
            }
            if (!Regex.IsMatch(member.Parameters, @"\bstring\s+expectedTargetId\b", RegexOptions.CultureInvariant)) continue;

            string path = RequestPath(half, members);
            List<string> codes = Regex.Matches(path, @"""(?<code>[a-z0-9_]+)""", RegexOptions.CultureInvariant)
                .Select(match => match.Groups["code"].Value)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            rows.Add(new Row(
                registration.ActionId,
                half,
                path.Contains(SettlementMarker, StringComparison.Ordinal),
                codes.Any(code => AbsenceCode.IsMatch(code)),
                codes.Where(code => ChangeCode.IsMatch(code)).ToList()));
        }

        return new Census(rows, unresolved);
    }

    /// <summary>
    /// The action's WHOLE request path: the request half plus every member of these partials it delegates to, two
    /// levels deep enough to reach the helper that mints the code. A resolution that stopped at the request half would
    /// report "no refusal" for every action whose refusal is built one call down - which is how the first reading of
    /// this gate missed `tree_chop_target_changed` and invented fourteen findings that did not exist.
    /// </summary>
    private static string RequestPath(string half, IReadOnlyDictionary<string, (string Parameters, string Body)> members)
    {
        List<string> parts = new();
        Queue<string> pending = new();
        HashSet<string> seen = new(StringComparer.Ordinal);
        pending.Enqueue(half);
        while (pending.Count > 0 && seen.Count <= 16)
        {
            string name = pending.Dequeue();
            if (!seen.Add(name) || !members.TryGetValue(name, out (string Parameters, string Body) member)) continue;
            parts.Add(member.Body);
            foreach (Match call in Regex.Matches(member.Body, @"(?:this\.)?(?<name>\w+)\s*\(", RegexOptions.CultureInvariant))
            {
                string called = call.Groups["name"].Value;
                if (members.ContainsKey(called) && !seen.Contains(called)) pending.Enqueue(called);
            }
        }

        return string.Join("\n", parts);
    }

    /// <summary>Action id to the request half its own handler arm names, read from the production switch arms.</summary>
    private static Dictionary<string, string> HandlerArms(Func<string, string, string>? edit)
    {
        Dictionary<string, string> arms = new(StringComparer.Ordinal);
        foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(HandlersDirectory), "*.cs").OrderBy(path => path, StringComparer.Ordinal))
        {
            string source = Read(file, edit);
            foreach (Match match in HandlerArm.Matches(source))
                arms.TryAdd(match.Groups["action"].Value, match.Groups["method"].Value);
        }
        return arms;
    }

    /// <summary>
    /// Every member the controller partials declare, by name, with its parameter list and its body: the braced form and
    /// the expression-bodied form both, because half of the request halves in this Mod are one-line expressions
    /// (`=> this.RequestLocalTileTarget(...)`) and a reading that skipped them would leave their action unreadable.
    /// </summary>
    private static Dictionary<string, (string Parameters, string Body)> MemberBodies(Func<string, string, string>? edit)
    {
        Dictionary<string, (string, string)> members = new(StringComparer.Ordinal);
        foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(ModDirectory), "farmhandexecutioncontroller*.cs").OrderBy(path => path, StringComparer.Ordinal))
        {
            string source = Read(file, edit);
            foreach (Match match in MemberDeclaration.Matches(source))
            {
                string name = match.Groups["name"].Value;
                bool arrow = match.Groups["open"].Value == "=>";
                int from = match.Index + match.Length;
                members.TryAdd(name, (match.Groups["parameters"].Value, BodyOf(source, arrow ? from - 2 : from - 1, arrow)));
            }
        }
        return members;
    }

    /// <summary>The body of the member whose `{` or `=>` is at <paramref name="start"/>.</summary>
    private static string BodyOf(string source, int start, bool arrow)
    {
        if (arrow)
        {
            int depth = 0;
            for (int index = start; index < source.Length; index++)
            {
                char character = source[index];
                if (character is '(' or '[' or '{') depth++;
                else if (character is ')' or ']' or '}') depth--;
                else if (character == ';' && depth == 0) return source[start..(index + 1)];
            }
            throw new InvalidOperationException($"unterminated expression body at offset {start}");
        }

        int braces = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                braces++;
                started = true;
            }
            else if (character == '}')
            {
                braces--;
                if (started && braces == 0) return source[start..(index + 1)];
            }
        }
        throw new InvalidOperationException($"unbalanced body at offset {start}");
    }

    /// <summary>Whether the catalogue's own declaration says this action's success takes the addressed row out of the world.</summary>
    private static bool Consumes(string actionId) =>
        FarmhandActionCatalog.Registrations
            .Single(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor!.Chore?.Consumes == true;

    private static bool Registered(string actionId) =>
        LegitimateRefusals.ContainsKey(actionId) || CollapsesTwoFacts.ContainsKey(actionId);

    private static string Read(string file, Func<string, string, string>? edit)
    {
        string text = File.ReadAllText(file);
        return edit is null ? text : edit(Path.GetFileName(file), text);
    }

    private static string RepositoryDirectory(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate)) return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {relative}");
    }

    /// <summary>The census, printed whole so a reader does no arithmetic and every named member is visible beside its count.</summary>
    private void Print(Census census, IReadOnlyList<Row> refusers, IReadOnlyList<Row> unregistered)
    {
        this.output.WriteLine(
            $"actions examined {census.Rows.Count} · re-resolve or settle {census.Rows.Count - refusers.Count} · refuse-on-move {unregistered.Count}"
                + $" · register {{ legitimate {LegitimateRefusals.Count}, collapses-two-facts {CollapsesTwoFacts.Count} }}");
        foreach (Row row in refusers.OrderBy(candidate => candidate.ActionId, StringComparer.Ordinal))
            this.output.WriteLine(
                $"  {(Registered(row.ActionId) ? "registered" : "UNREGISTERED")} {row.ActionId} ({row.RequestHalf}): {string.Join(", ", row.ChangeCodes)}");
    }

    /// <summary>One action's answer about a target it can no longer find at the named address.</summary>
    private sealed record Row(string ActionId, string RequestHalf, bool Settles, bool NamesAbsence, IReadOnlyList<string> ChangeCodes)
    {
        /// <summary>The action refuses, with the word for "the target is not what you remembered", and says nothing else.</summary>
        internal bool RefusesOnATargetThatMoved => !this.Settles && !this.NamesAbsence && this.ChangeCodes.Count > 0;
    }

    private sealed record Census(IReadOnlyList<Row> Rows, IReadOnlyList<string> Unresolved)
    {
        internal List<Row> Refusers() => this.Rows.Where(row => row.RefusesOnATargetThatMoved).ToList();
    }
}
