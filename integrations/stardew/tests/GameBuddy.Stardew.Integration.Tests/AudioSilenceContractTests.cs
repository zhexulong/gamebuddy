using System.Runtime.CompilerServices;
using FluentAssertions;
using GameBuddy.Stardew;
using StardewValley;
using StardewValley.Audio;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The audio half of the silent-background contract, pinned where it broke.
///
/// Observed live (2026-10-16): a run with <c>GAMEBUDDY_WINDOW_MODE=hidden</c> logged
/// "GameBuddy applying hidden window mode (silent, 60Hz background loop)." while the operator heard the title
/// music. The Mod zeroed <see cref="Options.musicVolumeLevel"/> and <see cref="Options.soundVolumeLevel"/>, but
/// those are only FIELDS: the engine's audible volume lives in its audio categories
/// (<c>Game1.initializeVolumeLevels()</c> and <c>Options.changeSliderOption</c> are the only two places that
/// apply them), so the categories kept whatever the engine had set.
///
/// These tests are the falsifier for that shape: a field-only implementation calls no category, and the
/// recording categories below would catch it.
/// </summary>
public sealed class AudioSilenceContractTests
{
    private sealed class RecordingCategory : IAudioCategory
    {
        private readonly List<float> volumes = new();

        public IReadOnlyList<float> Volumes => this.volumes;

        public void SetVolume(float volume) => this.volumes.Add(volume);
    }

    /// <summary>
    /// An <see cref="Options"/> that never ran its constructor: the real one reads <c>Game1.options</c>
    /// (Options.cs:397 -> :594), which does not exist outside a running game, and this mapping needs only the
    /// public volume fields.
    /// </summary>
    private static Options FieldOnlyOptions() => (Options)RuntimeHelpers.GetUninitializedObject(typeof(Options));

    [Fact]
    public void TheSilentContractReachesTheCategoriesNotJustTheOptionFields()
    {
        Options options = FieldOnlyOptions();
        options.musicVolumeLevel = 0.75f;
        options.soundVolumeLevel = 1f;
        options.ambientVolumeLevel = 0.75f;
        options.footstepVolumeLevel = 0.9f;
        RecordingCategory music = new();
        RecordingCategory sound = new();
        RecordingCategory ambient = new();
        RecordingCategory footstep = new();
        float musicPlayerVolume = -1f;
        float ambientPlayerVolume = -1f;

        ModEntry.SilenceAudioVolumes(
            options,
            music,
            sound,
            ambient,
            footstep,
            volume => musicPlayerVolume = volume,
            volume => ambientPlayerVolume = volume);

        // Every audible path the engine applies on a slider change, and the two player-volume fields the
        // music/ambient players fade against.
        music.Volumes.Should().Equal(0f);
        sound.Volumes.Should().Equal(0f);
        ambient.Volumes.Should().Equal(0f);
        footstep.Volumes.Should().Equal(0f);
        musicPlayerVolume.Should().Be(0f);
        ambientPlayerVolume.Should().Be(0f);
        options.musicVolumeLevel.Should().Be(0f);
        options.soundVolumeLevel.Should().Be(0f);
        options.ambientVolumeLevel.Should().Be(0f);
        options.footstepVolumeLevel.Should().Be(0f);
    }

    [Fact]
    public void AFieldOnlyImplementationWouldBeCaughtByTheseCategories()
    {
        // The shape that shipped before this fix: the fields are zeroed and no category is ever told.
        Options options = FieldOnlyOptions();
        RecordingCategory music = new();

        options.musicVolumeLevel = 0f;

        options.musicVolumeLevel.Should().Be(0f);
        music.Volumes.Should().BeEmpty();
    }
}
