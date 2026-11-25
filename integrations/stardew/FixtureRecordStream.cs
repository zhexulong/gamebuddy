using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew;

/// <summary>
/// THE FIXTURE'S RECORD STREAM: the one file the Host player's script channel appends to, shared by the paired world's
/// placement handshake.
///
/// <para>
/// WHY IT IS ITS OWN TYPE. Two processes write this file - the LAN master (the Host player's steps, the tile the
/// companion must stand on, and the two anchors the world was built around) and the companion's own process (the tile
/// she reached) - and both write the SAME flat record shape, so the writer and the reader that know that shape are one
/// thing rather than a method on whichever component happens to need it. The channel that owns `RecordsPath` builds its
/// own records and calls this to put them on the stream.
/// </para>
///
/// <para>
/// TWO WRITERS MEANS THE FILE IS OPENED FOR SHARING. A plain append opens with <c>FileShare.Read</c>, so the second
/// writer's line would fail with a sharing violation exactly when both sides are busiest - which reads downstream as an
/// unconfirmed placement rather than as a lost record. A read tolerates a half-written last line for the same reason: the
/// reader polls while the other process appends, so half a line is an ordinary state.
/// </para>
/// </summary>
internal static class FixtureRecordStream
{
    /// <summary>The action name every placement record carries, so one reader can pick them out of a stream of steps.</summary>
    internal const string PlacementAction = "placement";

    /// <summary>
    /// One line onto the stream, in the flat record shape the channel writes (<c>seq</c>/<c>stepId</c>/<c>action</c>/
    /// <c>state</c>/<c>reasonCode</c>/<c>location</c>/<c>x</c>/<c>y</c>/<c>requestedX</c>/<c>requestedY</c>/<c>detail</c>).
    ///
    /// <para>
    /// False, never an exception: the caller decides whether a record it could not write is its own failure. The directory
    /// is created, because the harness hands both sides a path whose parent may not exist yet.
    /// </para>
    /// </summary>
    internal static bool TryAppendRecord(string recordsPath, IReadOnlyDictionary<string, object?> record)
    {
        if (string.IsNullOrWhiteSpace(recordsPath) || !Path.IsPathFullyQualified(recordsPath))
            return false;
        try
        {
            string? directory = Path.GetDirectoryName(recordsPath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);
            byte[] line = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(record) + Environment.NewLine);
            using FileStream stream = new(recordsPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            stream.Write(line, 0, line.Length);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// One subject the paired world built, as the address a step resolves and the name a client is shown: its tile, the
    /// item the world publishes for it, and - for a container - the published id that IS its address. A crop carries no
    /// address because a crop is acted on by its tile; <see cref="Address"/> is empty for it rather than a second kind of
    /// subject.
    /// </summary>
    internal sealed record PlacementSubject(Vector2 Tile, string ItemId, string DisplayName, string Address);

    /// <summary>
    /// THE PAIRED WORLD'S TWO ANCHORS, and the window the fixture placed her in, published WITH the placement.
    ///
    /// <para>
    /// WHY THEY ARE PUBLISHED AND NOT DISCOVERED. Both subjects exist because this process built them, and the harness
    /// that walks the Host player to one of them used to re-derive it from the COMPANION's observation - which publishes
    /// crops and containers within <c>ExecutionManager.TargetDiscoveryRadius</c> of HER and nothing further. Those two
    /// facts cannot both hold: S1 must place her outside that radius to mean anything, and at seven tiles her own
    /// <c>harvestTargets</c> is empty by construction. So the tiles travel here, where the builder that chose them wrote
    /// them, and no reader re-derives a walking destination from her rows.
    /// </para>
    ///
    /// <para>
    /// <see cref="SeparationMinimum"/> and <see cref="SeparationMaximum"/> are the window the fixture ITSELF placed her
    /// in, in tiles (Chebyshev) from <see cref="Crop"/>'s tile. They are published because the harness's staging refusal
    /// and this placement are the same rule: two copies of the minimum - one here, one in the runner - is how the paired
    /// run came to place her at three to six tiles from a subject it then refused to judge inside seven.
    /// </para>
    /// </summary>
    internal sealed record PlacementAnchors(
        PlacementSubject Crop,
        PlacementSubject Chest,
        int SeparationMinimum,
        int SeparationMaximum);

    /// <summary>
    /// One record of the paired world's placement handshake: the map and tile it names, the tile that was asked for, the
    /// generation that binds a publication to the report made against it, the state and reason the writing process
    /// settled as, and - on a publication - the anchors the world was built around.
    /// </summary>
    internal sealed record PlacementRecord(
        string Location,
        Vector2 Tile,
        Vector2 RequestedTile,
        string Generation,
        string State,
        string ReasonCode,
        PlacementAnchors? Anchors);

    /// <summary>
    /// The record a placement step writes. Both sides write the same fields so one reader serves both: the tile the
    /// record is about (<c>x</c>/<c>y</c>), the tile that was asked for (<c>requestedX</c>/<c>requestedY</c>), and the
    /// generation - which is what makes a report attributable to the publication it answers rather than to whichever
    /// launch wrote a line first. <paramref name="anchors"/> is written by the publication only: her report answers a
    /// tile and carries no world of its own.
    /// </summary>
    internal static Dictionary<string, object?> PlacementRecordDocument(
        string state,
        string reasonCode,
        string location,
        Vector2 tile,
        Vector2 requestedTile,
        string generation,
        PlacementAnchors? anchors = null)
    {
        Dictionary<string, object?> record = new()
        {
            ["schema"] = HostPlayerScriptChannel.Schema,
            ["seq"] = null,
            ["stepId"] = null,
            ["action"] = PlacementAction,
            ["state"] = state,
            ["reasonCode"] = reasonCode,
            ["dayOfMonth"] = StardewValley.Game1.Date?.TotalDays ?? 0,
            ["timeOfDay"] = StardewValley.Game1.timeOfDay,
            ["location"] = location,
            ["x"] = (int)tile.X,
            ["y"] = (int)tile.Y,
            ["requestedX"] = (int)requestedTile.X,
            ["requestedY"] = (int)requestedTile.Y,
            ["detail"] = $"generation={generation}",
            ["atUnixMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        if (anchors is not null)
        {
            record["cropX"] = (int)anchors.Crop.Tile.X;
            record["cropY"] = (int)anchors.Crop.Tile.Y;
            record["cropItem"] = anchors.Crop.ItemId;
            record["cropItemName"] = anchors.Crop.DisplayName;
            record["chestX"] = (int)anchors.Chest.Tile.X;
            record["chestY"] = (int)anchors.Chest.Tile.Y;
            record["chestId"] = anchors.Chest.Address;
            record["chestItem"] = anchors.Chest.ItemId;
            record["chestItemName"] = anchors.Chest.DisplayName;
            record["separationMin"] = anchors.SeparationMinimum;
            record["separationMax"] = anchors.SeparationMaximum;
        }
        return record;
    }

    /// <summary>
    /// Every placement record on the stream, in file order. A line that is not one - the channel's own step records
    /// share this file - is skipped, and so is a partially written last line.
    /// </summary>
    internal static IReadOnlyList<PlacementRecord> ReadPlacementRecords(string recordsPath)
    {
        List<PlacementRecord> records = new();
        foreach (string line in ReadLines(recordsPath))
        {
            PlacementRecord? record = TryReadPlacementRecord(line);
            if (record is not null)
                records.Add(record);
        }
        return records;
    }

    /// <summary>The stream's lines, or none. A missing file and an unreadable one are both "no records yet".</summary>
    private static string[] ReadLines(string recordsPath)
    {
        if (string.IsNullOrWhiteSpace(recordsPath) || !File.Exists(recordsPath))
            return Array.Empty<string>();
        try
        {
            using FileStream stream = new(recordsPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using StreamReader reader = new(stream, Encoding.UTF8);
            return reader.ReadToEnd().Split('\n');
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>
    /// One line as a placement record, or null when it is something else (a step record, a half-written line, a value
    /// that is not an integer tile). Every field is read by name from the record's own shape; nothing is guessed from
    /// position.
    /// </summary>
    private static PlacementRecord? TryReadPlacementRecord(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
            return null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(line);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !string.Equals(StringField(root, "action"), PlacementAction, StringComparison.Ordinal)
                || !int.TryParse(StringField(root, "x"), out int tileX)
                || !int.TryParse(StringField(root, "y"), out int tileY))
                return null;
            int requestedX = int.TryParse(StringField(root, "requestedX"), out int parsedX) ? parsedX : tileX;
            int requestedY = int.TryParse(StringField(root, "requestedY"), out int parsedY) ? parsedY : tileY;
            return new PlacementRecord(
                StringField(root, "location"),
                new Vector2(tileX, tileY),
                new Vector2(requestedX, requestedY),
                ReadGeneration(StringField(root, "detail")),
                StringField(root, "state"),
                StringField(root, "reasonCode"),
                ReadAnchors(root));
        }
        catch (JsonException)
        {
            // Half a line, or a line another writer is still finishing.
            return null;
        }
    }

    /// <summary>
    /// The anchors a publication carries, or null when this line carries none - a report from her process, the Host's own
    /// refusal, or a record written before the anchors travelled at all. A reader that needs an anchor says which one it
    /// is missing; a half-written anchor set is never assembled out of the fields that happen to parse.
    /// </summary>
    private static PlacementAnchors? ReadAnchors(JsonElement root)
    {
        if (!TryIntField(root, "cropX", out int cropX) || !TryIntField(root, "cropY", out int cropY)
            || !TryIntField(root, "chestX", out int chestX) || !TryIntField(root, "chestY", out int chestY)
            || !TryIntField(root, "separationMin", out int separationMinimum)
            || !TryIntField(root, "separationMax", out int separationMaximum))
            return null;
        return new PlacementAnchors(
            new PlacementSubject(
                new Vector2(cropX, cropY),
                StringField(root, "cropItem"),
                StringField(root, "cropItemName"),
                Address: string.Empty),
            new PlacementSubject(
                new Vector2(chestX, chestY),
                StringField(root, "chestItem"),
                StringField(root, "chestItemName"),
                StringField(root, "chestId")),
            separationMinimum,
            separationMaximum);
    }

    /// <summary>One integer field of a record, by name; false when the line does not carry a whole number under it.</summary>
    private static bool TryIntField(JsonElement root, string name, out int value) =>
        int.TryParse(StringField(root, name), out value);

    /// <summary>A record's field as text: the string it carries, or the invariant number, or empty when it has none.</summary>
    private static string StringField(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value))
            return string.Empty;
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Number => value.ToString(),
            _ => string.Empty,
        };
    }

    /// <summary>
    /// The generation a record carries, out of the <c>;</c>-separated <c>key=value</c> detail both sides write. Empty
    /// when the line carries none, which no reader may treat as a match.
    /// </summary>
    internal static string ReadGeneration(string detail)
    {
        foreach (string part in detail.Split(';'))
        {
            int separator = part.IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0)
                continue;
            if (part.AsSpan(0, separator).SequenceEqual("generation".AsSpan()))
                return part[(separator + 1)..].Trim();
        }
        return string.Empty;
    }
}
