// integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/SopStepPipelinePropertyTests.cs
namespace GameBuddy.Stardew.Core.Tests;

using System;
using System.Collections.Generic;
using System.Text.Json;
using FsCheck;
using FsCheck.Xunit;
using FluentAssertions;
using Xunit;
using GameBuddy.Stardew.Core.Algebra;

public sealed class SopStepPipelinePropertyTests
{
    private sealed class MockStepRunner : ISopStepRunner
    {
        private readonly Func<int, string, Result<string, string>> _evaluator;
        public List<int> ExecutedSteps { get; } = new();

        public MockStepRunner(Func<int, string, Result<string, string>> evaluator) => _evaluator = evaluator;

        public Result<string, string> ExecuteStep(int stepIndex, string actionType, IReadOnlyDictionary<string, JsonElement> args)
        {
            this.ExecutedSteps.Add(stepIndex);
            return this._evaluator(stepIndex, actionType);
        }

        public object? SampleStateProperty(string location, int tileX, int tileY, string propertyPath)
        {
            return true;
        }
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_ShortCircuitsAtFirstFailure_AndPreservesExactStepReceipts(PositiveInt totalSteps, PositiveInt failAt)
    {
        int n = (totalSteps.Get % 10) + 1;
        int failIdx = (failAt.Get % n);

        var runner = new MockStepRunner((idx, _) => idx == failIdx ? Result<string, string>.Fail("mock_failure") : Result<string, string>.Ok("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        bool isCorrectSuccessState = result.IsSuccess == false;
        bool isCorrectFailedIndex = result.FailedStepIndex == failIdx;
        bool isCorrectExecutionCount = runner.ExecutedSteps.Count == failIdx + 1;
        bool isCorrectReceiptsCount = result.StepReceipts.Count == failIdx + 1;

        return (isCorrectSuccessState && isCorrectFailedIndex && isCorrectExecutionCount && isCorrectReceiptsCount).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_SucceedsAll_WhenNoStepFails(PositiveInt totalSteps)
    {
        int n = (totalSteps.Get % 10) + 1;
        var runner = new MockStepRunner((_, _) => Result<string, string>.Ok("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        return (result.IsSuccess && result.FailedStepIndex == null && result.StepReceipts.Count == n).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_ContainsNativeExceptions_FailClosed(PositiveInt totalSteps, PositiveInt throwAt)
    {
        int n = (totalSteps.Get % 10) + 1;
        int throwIdx = (throwAt.Get % n);

        var runner = new MockStepRunner((idx, _) =>
        {
            if (idx == throwIdx) throw new InvalidOperationException("Native engine crash simulation");
            return Result<string, string>.Ok("step_succeeded");
        });

        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        bool failedCorrectly = !result.IsSuccess && result.FailedStepIndex == throwIdx;
        bool exceptionRecorded = result.ReasonCode.Contains("exception_invalidoperationexception");
        bool stoppedAtThrow = runner.ExecutedSteps.Count == throwIdx + 1;

        return (failedCorrectly && exceptionRecorded && stoppedAtThrow).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_FailsClosed_OnCorruptedStepIndexSequence(PositiveInt totalSteps, PositiveInt badIndexOffset)
    {
        int n = (totalSteps.Get % 10) + 1;
        var runner = new MockStepRunner((_, _) => Result<string, string>.Ok("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            int index = (i == 0) ? i + (badIndexOffset.Get % 5 + 1) : i;
            steps.Add(new SopStepWireDescriptor(index, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        return (!result.IsSuccess && result.ReasonCode == "invalid_step_index_sequence").ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_ShortCircuits_OnExpiredDeadline(PositiveInt totalSteps)
    {
        int n = (totalSteps.Get % 10) + 1;
        var runner = new MockStepRunner((_, _) => Result<string, string>.Ok("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < n; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        long expiredDeadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1000;
        var result = pipeline.Execute(steps, expiredDeadline);

        bool failedWithTimeout = !result.IsSuccess && result.ReasonCode == "timed_out";
        bool executedZeroSteps = runner.ExecutedSteps.Count == 0;
        return (failedWithTimeout && executedZeroSteps).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Pipeline_Enforces_MaxPipelineSteps_Limit(PositiveInt extraSteps)
    {
        int total = SopStepPipelineRunner.MaxPipelineSteps + (extraSteps.Get % 20 + 1);
        var runner = new MockStepRunner((_, _) => Result<string, string>.Ok("step_succeeded"));
        var steps = new List<SopStepWireDescriptor>();
        for (int i = 0; i < total; i++)
        {
            steps.Add(new SopStepWireDescriptor(i, $"step_{i}", new Dictionary<string, JsonElement>()));
        }

        var pipeline = new SopStepPipelineRunner(runner);
        var result = pipeline.Execute(steps);

        return (!result.IsSuccess && result.ReasonCode == "pipeline_too_long" && runner.ExecutedSteps.Count == 0).ToProperty();
    }
}
