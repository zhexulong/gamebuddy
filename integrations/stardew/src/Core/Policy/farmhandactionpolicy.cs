namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The action policy the Host pushes to a RUNNING world (`farmhand_action_policy_request`).
///
/// <para>
/// The payload is the SAME payload the durable document carries rather than a second schema: the same two
/// denial keys, holding the same values, that the Host's projection writes into `config.json`. Only the
/// casing differs, and the bridge's own codec decides it - <see cref="Protocol.BridgeProtocol.JsonOptions"/>
/// renders every frame camelCase (`deniedActions`), exactly as it renders the two `ModConfig` keys this
/// record binds to, and reads them back case-insensitively. One shape, one record, one codec.
/// </para>
///
/// <para>
/// The remaining `ModConfig` keys a settings save can change (`WindowMode`, `PresentationLocale`,
/// `AdvanceDayMinimumOnlineFarmers`) are deliberately absent: nothing on the Mod re-reads them while a world
/// is running, so a field here that no code consumes would be a field that lies about its reach.
/// </para>
///
/// <para>
/// The frame carries the DENIAL half only. Consent is deny-by-exception and derived from the Mod's own
/// registration catalog, so an empty pair means "the catalog's default consent set" and a frame can only
/// ever narrow the published surface.
/// </para>
/// </summary>
public sealed record FarmhandActionPolicy
{
    public List<string> DeniedActions { get; init; } = new();
    public List<string> DeniedActionFamilies { get; init; } = new();
}
