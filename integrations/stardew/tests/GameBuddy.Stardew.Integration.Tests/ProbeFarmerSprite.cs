using System.Reflection;
using Netcode;
using StardewValley;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Seeds the engine object the disposition's <c>SelfAnimation</c> fact reads off a probe farmer.
///
/// <para>
/// <c>Farmer.FarmerSprite</c> is <c>(FarmerSprite)Sprite</c>, and <c>Character.sprite</c> is an inline-initialised
/// <c>NetRef</c> that an uninitialised probe farmer leaves NULL - so a probe that does not seed it makes
/// <c>WorldModel.ReadFacts</c> throw instead of reading a body, and every admission test built on that probe fails
/// outside the fact it was written for. This is the same completeness the <c>UsingTool</c> and <c>Stamina</c> reads
/// already require of these probes.
/// </para>
///
/// <para>
/// The flag is the engine's own single-animation pause (<c>FarmerSprite.cs:670-673</c> raises it,
/// <c>:792</c>/<c>:1024</c> lower it), so a probe sets it exactly as the engine would, and nothing here simulates an
/// animation timeline.
/// </para>
/// </summary>
internal static class ProbeFarmerSprite
{
    internal static void Attach(Farmer actor, bool pausedForSingleAnimation = false)
    {
        var sprite = new FarmerSprite { PauseForSingleAnimation = pausedForSingleAnimation };
        typeof(Character)
            .GetField("sprite", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetRef<AnimatedSprite>(sprite));
    }
}
