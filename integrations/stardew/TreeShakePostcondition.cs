namespace GameBuddy.Stardew;

/// <summary>
/// What one <c>shake_tree</c> swing PROVED, read from the two native flags it can see before and after.
///
/// <para>
/// THE DEFECT THIS REPLACES was a postcondition the engine never promised. The handler asked for
/// <c>!has_seed_after &amp;&amp; shaken_today</c> - "the seed left the tree and the tree counts as shaken" - and published
/// the pair as if a fulfilled shake must clear <c>hasSeed</c>. MEASURED `round85`: both <c>shake_tree</c> nodes
/// (<c>plan_483</c> at Forest 57,20 and <c>plan_486</c> at 53,21) settled <c>Uncertain</c> with
/// <c>tree_shake_postcondition_unavailable</c>, which the program turned into <c>recovery_required</c>, on evidence that
/// reads <c>has_seed_before=true;has_seed_after=true;shaken_today=true</c> - the swing HAD happened, and the half of the
/// pair that was false is the half the engine does not guarantee.
/// </para>
///
/// <para>
/// WHY THE SEED IS NOT THE POSTCONDITION. <c>Tree.shake</c> runs at all only inside
/// <c>if ((maxShake == 0f || doEvenIfStillShaking) &amp;&amp; growthStage.Value &gt;= 3 &amp;&amp; !stump.Value)</c>
/// (Tree.cs:643), and it writes <c>wasShakenToday.Value = true</c> there (:711-715) before any drop. The drop is gated a
/// second and third time: the seed branch lives inside <c>if (growthStage.Value &gt;= 5)</c> (:647) and asks
/// <c>hasSeed.Value &amp;&amp; (Game1.IsMultiplayer || Game1.player.ForagingLevel &gt;= 1)</c> (:668); only that branch clears
/// <c>hasSeed.Value = false</c> (:709), and <c>hasSeed</c> itself is set from <c>SeedOnShakeChance</c> on a day update for
/// a full-grown tree (:945). A single-player farmer below foraging 1 therefore shakes a seeded tree and gets no seed, by
/// the engine's own rule. A postcondition that demanded a drop would have to call that a failure, and the only state left
/// for it is <c>Uncertain</c> - the third way this repository refuses.
/// </para>
///
/// <para>
/// SO THE ASSERTION IS THE FLIP THE ENGINE DOES WRITE: the same-day flag the tree did not carry before it now carries.
/// The seed drop stays in the sentence as <c>seed_dropped</c>, OBSERVED and never asserted - the same split
/// <c>harvest_bush</c> makes for a size-4 bush's queued drop (<c>item_dropped_in_frame</c>), and the same reason: a fact
/// the engine may legitimately withhold is not evidence about the click.
/// </para>
/// </summary>
internal readonly record struct TreeShakePostcondition(
    bool HasSeedBefore,
    bool HasSeedAfter,
    bool ShakenTodayBefore,
    bool ShakenTodayAfter) : IReadsAWorldStateBeforeAndAfter
{
    /// <summary>
    /// The call whose return the pair is read after: <c>Tree.shake</c> is the only mutation this action performs, and it
    /// writes both flags synchronously, so a "nothing changed" reading is a fact about the world rather than a check that
    /// outran the engine.
    /// </summary>
    private const string Settle = "tree.shake";

    public string ActionId => ExecutionManager.ShakeTreeActionId;

    public PostconditionReadPoint ReadPoint => PostconditionReadPoint.AfterTheSettle;

    /// <summary>
    /// The engine accepted the swing: the flag it sets for every accepted shake, and which the tree did not carry before.
    /// </summary>
    internal bool Shaken => !this.ShakenTodayBefore && this.ShakenTodayAfter;

    /// <summary>
    /// The seed the tree happened to give, which is a fact about the tree and the farmer's foraging level rather than
    /// about this swing. <c>false</c> on a completed shake is normal, and the sentence says so beside <c>shaken</c>.
    /// </summary>
    internal bool SeedDropped => this.HasSeedBefore && !this.HasSeedAfter;

    internal string Describe(string targetId, int tileX, int tileY) =>
        $"target={targetId};tile={tileX},{tileY};"
        + $"has_seed_before={this.HasSeedBefore.ToString().ToLowerInvariant()};has_seed_after={this.HasSeedAfter.ToString().ToLowerInvariant()};"
        + $"seed_dropped={this.SeedDropped.ToString().ToLowerInvariant()};"
        + $"shaken_today_before={this.ShakenTodayBefore.ToString().ToLowerInvariant()};shaken_today={this.ShakenTodayAfter.ToString().ToLowerInvariant()};"
        + $"settle={Settle};read={this.ReadPoint.ToWireValue()}";
}
