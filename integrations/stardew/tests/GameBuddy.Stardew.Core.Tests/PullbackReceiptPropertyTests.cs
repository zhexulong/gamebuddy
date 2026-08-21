// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/PullbackReceiptPropertyTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System;
using System.Collections.Generic;
using System.Text.Json;
using FsCheck;
using FsCheck.Xunit;
using FluentAssertions;
using Xunit;
using GameBuddy.Stardew.Core.Algebra;

public sealed class PullbackReceiptPropertyTests
{
    [Property(MaxTest = 100)]
    public Property PullbackReceipt_EqualizerMatches_OnlyWhenExpectedEqualsActual(int expected, int actual)
    {
        var evidence = new CompositeExecutionReceiptPayload(
            "sop_composite_pipeline",
            "mine.currentFloor",
            new SopLocationDescriptor("UndergroundMine11", new SopTileDescriptor(10, 12)),
            expected,
            actual,
            expected == actual,
            Array.Empty<SopStepReceipt>(),
            null
        );

        return (evidence.EqualizerMatched == (expected == actual)).ToProperty();
    }
}
