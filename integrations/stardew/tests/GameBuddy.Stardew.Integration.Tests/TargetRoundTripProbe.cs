using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Netcode;
using StardewValley;
using StardewValley.Network;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Drives ONE published row through the action's own preflight, through the same handler the production router
/// dispatches to.
///
/// <para>
/// The request is built from the ROW, not from a hand-written per-action table: each argument the descriptor declares
/// is filled from the row field it names (`expectedTargetId` from `targetId`/`chestId`, `expectedQualifiedItemId` from
/// `qualifiedItemId`/`qualifiedHarvestItemId`, `x`/`y`/`slot` from their own names). A second table would be a second
/// authority over "what a row is", which is the defect this file exists to catch.
/// </para>
/// <para>
/// The verdict is about TARGET IDENTITY, deliberately and narrowly. A preflight may still refuse a row because the
/// actor holds no axe, the pack is full, or the machine is out of reach - none of those is a disagreement between
/// discovery and execution, and calling them one would make this gate cry wolf until someone muted it. What it may
/// never answer is "the target you named is not the target I see", because that row came from the action's own
/// declared family one line earlier.
/// </para>
/// </summary>
internal static class TargetRoundTripProbe
{
    /// <summary>
    /// The refusal codes that mean DISCOVERY AND EXECUTION DISAGREE about which target a row names.
    ///
    /// Read from the shape every action's own staleness refusal already uses (`rock_target_changed`,
    /// `shipping_bin_target_changed`, `chest_target_changed`, `door_not_available`, `observation_binding_target_unavailable`)
    /// rather than listed per action: a new action's staleness code joins the class by following the convention its
    /// family already established, and one that invents a different word fails here by NAME so the omission is visible.
    /// </summary>
    private static readonly string[] TargetIdentityRefusalShapes =
    {
        "target_changed",
        "target_unavailable",
        "target_moved",
        "target_not_found",
        // `npc_relationship_target_gone` / `talk_to_npc_target_not_found` are the NPC family's spelling of the same
        // fact, and `target_gone` was missing until an injected mismatch made the probe report it as unreadable rather
        // than as the disagreement it is.
        "target_gone",
        "not_available",
        "target_invalid",
    };

    internal readonly record struct Outcome(
        bool Accepted,
        int Rows,
        string Refusal,
        string FirstRow,
        /// <summary>
        /// Set when the shipped projection or the preflight reached a content/native read this headless process cannot
        /// perform. That is the HARNESS's limit, not a disagreement between discovery and execution, and it is reported
        /// as its own fact so it can never be counted as a pass.
        /// </summary>
        string HarnessLimit = "",
        /// <summary>
        /// Every state/reason pair the receipts actually carried, in row order. Printed beside the verdict so a reader
        /// can see WHAT decided a pass rather than only that one was reached: a pair that passes on `accepted` and a
        /// pair that passes because a refusal code fell through both lists look identical in `Accepted` alone.
        /// </summary>
        string Detail = "",
        /// <summary>
        /// Set when the preflight refused with a code this probe cannot classify - it names neither a target
        /// disagreement nor a pre-target gate, so nobody has said whether the target was read.
        ///
        /// This is NOT a harness limit and must not share its field: a harness limit is a fact about this process (a
        /// content manager it does not have), while an unreadable code is a fact about the PROBE's vocabulary. Merging
        /// them made the injected-mismatch check report `equip_tool` as blind when it had in fact refused correctly.
        /// </summary>
        string UnreadableRefusal = "");

    internal static Outcome Run(TargetFamilyWorld world, string actionId, string family, bool corruptIdentity = false)
    {
        IReadOnlyList<object> rows;
        try
        {
            rows = Rows(world, family);
        }
        catch (Exception exception) when (IsHarnessLimit(exception))
        {
            // The shipped `Discover*` dereferenced a content-backed field this process never populates (the crop
            // projections call `Crop.GetData()` -> `Game1.cropData`, loaded from `Data/Crops`). Named as the harness
            // limit it is, rather than as a product defect.
            return new Outcome(false, 0, "harness limit", "<none>", HarnessLimit: DescribeLimit(exception));
        }

        if (rows.Count == 0) return new Outcome(false, 0, "no rows", "<none>");

        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == actionId);
        FarmhandActionHandlerGroup group = registration.HandlerGroup!.Value;

        ExecutionManager executions = world.NewExecutionManager(actionId);
        IFarmhandActionHandler handler = HandlerFor(group, executions);

        var refusals = new List<string>();
        var preTarget = new List<string>();
        var unclassified = new List<string>();
        var thrown = new List<string>();
        var codes = new List<string>();
        foreach (object row in rows)
        {
            BridgeExecutionArgs? args = ArgumentsFor(registration, row);
            if (args is null)
            {
                refusals.Add("the row publishes no field this action's declared arguments can be filled from");
                continue;
            }

            if (corruptIdentity) args = CorruptIdentity(args);

            long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            LocalExecutionReceipt receipt;
            try
            {
                receipt = handler.Execute(
                    new BridgeExecutionRequest(
                        $"roundtrip_{actionId}",
                        $"roundtrip_{actionId}",
                        actionId,
                        args,
                        1,
                        deadline),
                    executions);
            }
            catch (Exception exception) when (IsHarnessLimit(exception))
            {
                // The preflight got past identity and reached a native/content read this process cannot perform.
                // Counted, not skipped: a throw says nothing about the target, so it may not sit in the same bucket
                // as a pass. (Before this, twelve of the sixteen driven pairs "passed" on a swallowed
                // NullReferenceException from a missing Farmer NetField.)
                string frame = $"{DescribeLimit(exception)}@{TopFrame(exception)}";
                thrown.Add(frame);
                codes.Add($"threw/{frame}");
                continue;
            }

            codes.Add($"{receipt.State.ToString().ToLowerInvariant()}/{receipt.ReasonCode}");

            if (IsPreTargetRefusal(receipt.ReasonCode))
            {
                preTarget.Add(receipt.ReasonCode);
                continue;
            }

            if (IsTargetIdentityRefusal(receipt.ReasonCode))
            {
                refusals.Add(receipt.ReasonCode);
                continue;
            }

            // The exhaustive third bucket. A refusal whose code neither names a target disagreement nor belongs to
            // the pre-target list is one this probe CANNOT READ: it may have stopped before the target or after it,
            // and nobody has said which. Before this bucket existed such a code fell through `continue` and the pair
            // reported a pass - `chest_empty`, `item_not_owned_in_slot`, `observation_binding_precondition_failed`
            // and `already_equipped` were all "passing" that way. The default is now UNPROVEN, never green.
            if (IsSuccessState(receipt.State)) continue;
            unclassified.Add(receipt.ReasonCode);
        }

        string detail = string.Join(", ", codes);

        // A pre-target refusal means the target was never examined, so this pair proves NOTHING. Reported as the
        // harness limit it is rather than as a pass - the vacuous shape this file exists to prevent.
        if (refusals.Count == 0 && preTarget.Count > 0)
            return new Outcome(false, rows.Count, preTarget[0], DescribeRow(rows[0]), HarnessLimit: preTarget[0], Detail: detail);

        // A THROW is also this process's limit, not a verdict: the preflight got past the target check and then reached a
        // native effect this harness cannot run.
        if (refusals.Count == 0 && thrown.Count > 0)
            return new Outcome(false, rows.Count, thrown[0], DescribeRow(rows[0]), HarnessLimit: thrown[0], Detail: detail);

        // An unreadable code is reported as its own fact: the pair is not a pass, and it is not a harness limit either.
        if (refusals.Count == 0 && unclassified.Count > 0)
            return new Outcome(false, rows.Count, unclassified[0], DescribeRow(rows[0]), UnreadableRefusal: unclassified[0], Detail: detail);

        return refusals.Count == 0
            ? new Outcome(true, rows.Count, string.Empty, DescribeRow(rows[0]), Detail: detail)
            : new Outcome(false, rows.Count, refusals[0], DescribeRow(rows[0]), Detail: detail);
    }

    /// <summary>
    /// The states in which the handler ran the action to a conclusion, which means the target check DID run and
    /// passed. Anything else is a refusal the probe has to classify rather than absorb.
    /// </summary>
    private static bool IsSuccessState(ExecutionState state) =>
        state is ExecutionState.Accepted
            or ExecutionState.Running
            or ExecutionState.MeaningfulProgress
            or ExecutionState.Succeeded
            or ExecutionState.PartiallySucceeded;

    /// <summary>
    /// The rows a family publishes.
    ///
    /// Every family but `warps` comes from the action's own `Discover*` method. `warps` has none - the snapshot
    /// projects `player.currentLocation.warps` INLINE - so it is projected here in the same shape the snapshot
    /// publishes (`sourceX, sourceY, target, accessible`), from the same `location.warps` list. That is the one place
    /// this file restates a projection, and it is stated rather than hidden: a family with no `Discover*` cannot be
    /// driven through one, and skipping it would park the round19 defect in `Undriven` as though the world could not
    /// build a warp.
    /// </summary>
    private static IReadOnlyList<object> Rows(TargetFamilyWorld world, string family) =>
        family == "warps" ? world.WarpRows() : world.Rows(family);

    /// <summary>
    /// Refusals that mean the preflight stopped BEFORE it looked at the target at all.
    ///
    /// The tool family is the case that matters: `chop_tree_source` and `break_rock_source` refuse
    /// `*_not_equipped_in_requested_slot` / `tool_not_owned:<category>` before any tile is read. Counting such a refusal
    /// as a pass is exactly the vacuous shape this gate exists for - measured while proving this gate red: an injected
    /// `rock:Farm:3,2` identity mismatch went UNNOTICED because the pack held no pickaxe, so the preflight refused the
    /// tool and the target check never ran. It is reported as a harness limit instead, never as a round trip.
    ///
    /// <para>
    /// `world_not_ready` and `player_not_actionable` belong here for the SAME reason and were missing, which made this
    /// whole gate vacuous: measured 2026-11-01, every one of the sixteen driven pairs returned `Accepted` while the
    /// only thing that had happened was `AdmitExecution` or the body's own `!Context.IsWorldReady` opening line
    /// refusing the request. Neither code was in either list, so both fell through the `IsTargetIdentityRefusal` test
    /// below and the pair reported a pass. The admission gate and the readiness gate are both in FRONT of the target
    /// read, so a refusal from either proves exactly as little as a missing pickaxe does.
    /// </para>
    /// </summary>
    private static readonly string[] PreTargetRefusalShapes =
    {
        "not_equipped_in_requested_slot",
        "tool_not_owned",
        "tool_upgrade_insufficient",
        "slot_out_of_range",
        "world_not_ready",
        "player_not_actionable",
    };

    private static bool IsPreTargetRefusal(string reasonCode) =>
        PreTargetRefusalShapes.Any(shape => reasonCode.Contains(shape, StringComparison.Ordinal));

    private static bool IsTargetIdentityRefusal(string reasonCode) =>
        TargetIdentityRefusalShapes.Any(shape => reasonCode.Contains(shape, StringComparison.Ordinal));

    /// <summary>
    /// Whether this exception is the HARNESS running out of content, not the product disagreeing with itself.
    ///
    /// Three shapes, each named by the process fact behind it: a null dereference inside the game's own
    /// content-backed accessors (`Crop.GetData()` -> `Game1.cropData`); the `ContentLoadException`
    /// `LocalizedContentManager` raises when no content manager is installed at all (`Tree._LoadWildTreeData`); and
    /// the `KeyNotFoundException` `ItemRegistry.RequireTypeDefinition` raises when the item type-definition registry
    /// (`Data/Objects`) was never populated. Anything else propagates, so a real defect is never swallowed.
    /// </summary>
    private static bool IsHarnessLimit(Exception exception) =>
        exception is TargetUnavailableException
        || exception is NullReferenceException
        || exception is Microsoft.Xna.Framework.Content.ContentLoadException
        || (exception is KeyNotFoundException missing && missing.Message.StartsWith("No item type definition found", StringComparison.Ordinal))
        || (exception is TargetInvocationException { InnerException: { } inner } && IsHarnessLimit(inner));

    private static string DescribeLimit(Exception exception) =>
        exception is TargetInvocationException { InnerException: { } inner }
            ? inner.GetType().Name
            : exception.GetType().Name;

    private static string TopFrame(Exception exception)
    {
        Exception target = exception is TargetInvocationException { InnerException: { } inner } ? inner : exception;
        StackTrace? trace = new StackTrace(target, fNeedFileInfo: false);
        return trace.FrameCount == 0
            ? "<none>"
            : $"{trace.GetFrame(0)!.GetMethod()?.DeclaringType?.Name}.{trace.GetFrame(0)!.GetMethod()?.Name}";
    }

    /// <summary>
    /// The request one published row implies, filled from the action's OWN declared arguments.
    ///
    /// `null` when a declared argument names no field the row publishes - which is itself a finding, and is reported
    /// rather than guessed at.
    /// </summary>
    private static BridgeExecutionArgs? ArgumentsFor(FarmhandActionRegistration registration, object row)
    {
        float? x = null, y = null;
        int? slot = null;
        string? chestId = null, expectedTargetId = null, expectedQualifiedItemId = null, tool = null;
        bool any = false;
        foreach (FarmhandActionArgument argument in registration.Descriptor!.Arguments)
        {
            string? value = FieldFor(row, argument.Name);
            if (value is null) continue;
            switch (argument.Name)
            {
                case "x":
                    x = float.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case "y":
                    y = float.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case "slot":
                    slot = int.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case "chestId":
                    chestId = value;
                    break;
                case "expectedTargetId":
                    expectedTargetId = value;
                    break;
                case "expectedQualifiedItemId":
                    expectedQualifiedItemId = value;
                    break;
                case "tool":
                    tool = value;
                    break;
                default:
                    continue;
            }

            any = true;
        }

        return any
            ? new BridgeExecutionArgs
            {
                X = x,
                Y = y,
                Slot = slot,
                ChestId = chestId,
                ExpectedTargetId = expectedTargetId,
                ExpectedQualifiedItemId = expectedQualifiedItemId,
                Tool = tool,
            }
            : null;
    }

    /// <summary>
    /// The same request with its IDENTITY argument broken, for the gate's own red check.
    ///
    /// Which argument is broken is derived from the request, not from a per-action table: the target id when the action
    /// names one, the container id when it names a container, and the tool selector for the one action whose target IS
    /// a tool category (`equip_tool` declares `tool` and no target id at all). Corrupting the wrong field would make the
    /// check pass for the wrong reason, so the order matters: the most specific identity first.
    /// </summary>
    private static BridgeExecutionArgs CorruptIdentity(BridgeExecutionArgs args)
    {
        bool hasTargetIdentity = args.ExpectedTargetId is not null || args.ChestId is not null;
        return new BridgeExecutionArgs
        {
            X = args.X,
            Y = args.Y,
            Slot = args.Slot,
            ChestId = args.ChestId is null ? null : args.ChestId + "_injected",
            ExpectedTargetId = args.ExpectedTargetId is null ? null : args.ExpectedTargetId + "_injected",
            ExpectedQualifiedItemId = args.ExpectedQualifiedItemId,
            // `equip_tool` names no target id at all: its target IS the tool category, so that is the identity a
            // corrupted request breaks. Leaving it intact would make the pair look blind when it is not.
            Tool = !hasTargetIdentity && args.Tool is not null ? args.Tool + "_injected" : args.Tool,
        };
    }

    /// <summary>
    /// The row field an argument name reads, by the ONE convention every family follows: the caller's assertion
    /// (`expected` prefix) names a fact the row publishes without it.
    ///
    /// <para>
    /// `expectedQualifiedItemId` also reads a container row's FIRST item, because a `BridgeChestState` publishes its
    /// contents as nested `BridgeChestItem` rows rather than as a top-level id. Without that, both chest actions were
    /// handed a null item id and refused `item_not_owned_in_slot` / `chest_empty` before reading their target - the same
    /// vacuous shape this gate exists for, one indirection further out.
    /// </para>
    /// </summary>
    private static string? FieldFor(object row, string argumentName)
    {
        string[] candidates = argumentName switch
        {
            "expectedTargetId" => new[] { "TargetId", "ChestId", "X" },
            "expectedQualifiedItemId" => new[] { "QualifiedItemId", "QualifiedHarvestItemId", "CropId" },
            // `equip_tool` selects a tool CATEGORY, and `toolSlots` publishes exactly that word per slot, so the
            // argument reads the row's own `category` rather than a second vocabulary.
            "tool" => new[] { "Category" },
            "x" => new[] { "X", "SourceX" },
            "y" => new[] { "Y", "SourceY" },
            _ => new[] { char.ToUpperInvariant(argumentName[0]) + argumentName[1..] },
        };

        foreach (string candidate in candidates)
        {
            PropertyInfo? property = row.GetType().GetProperty(candidate);
            if (property is null) continue;
            object? value = property.GetValue(row);
            if (value is null) continue;
            if (value is string text && text.Length > 0) return text;
            if (value is int or float or long) return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
        }

        return argumentName == "expectedQualifiedItemId" ? FirstNestedItemId(row) : null;
    }

    /// <summary>The first item id a container row publishes inside its own `Items` list, or null for every other row.</summary>
    private static string? FirstNestedItemId(object row)
    {
        if (row.GetType().GetProperty("Items")?.GetValue(row) is not System.Collections.IEnumerable items) return null;
        foreach (object? item in items)
        {
            if (item?.GetType().GetProperty("QualifiedItemId")?.GetValue(item) is string id && id.Length > 0) return id;
        }

        return null;
    }

    private static string DescribeRow(object row) =>
        string.Join(
            ",",
            row.GetType().GetProperties()
                .Where(property => property.PropertyType == typeof(string) || property.PropertyType == typeof(int))
                .Select(property => $"{property.Name}={property.GetValue(row)}")
                .Take(6));

    /// <summary>
    /// The handler the production router dispatches this group to, selected from the registration catalog's own
    /// group so there is no second action-to-handler table here.
    /// </summary>
    private static IFarmhandActionHandler HandlerFor(FarmhandActionHandlerGroup group, ExecutionManager executions) =>
        group switch
        {
            FarmhandActionHandlerGroup.Movement => new MovementActionHandler(executions),
            FarmhandActionHandlerGroup.Farming => new FarmingActionHandler(executions),
            FarmhandActionHandlerGroup.Gathering => new GatheringActionHandler(executions),
            FarmhandActionHandlerGroup.MachinesAndAnimals => new MachineAndAnimalActionHandler(executions),
            FarmhandActionHandlerGroup.ResourceTools => new ResourceToolActionHandler(executions),
            FarmhandActionHandlerGroup.Expression => new ExpressionActionHandler(executions),
            FarmhandActionHandlerGroup.WorldLifecycle => new WorldLifecycleActionHandler(executions),
            FarmhandActionHandlerGroup.Modal => new ModalActionHandler(executions),
            _ => throw new InvalidOperationException($"no handler for group {group}"),
        };

    /// <summary>Thrown when a preflight reaches a native or content read this headless process cannot perform.</summary>
    internal sealed class TargetUnavailableException : Exception
    {
    }
}
