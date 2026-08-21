using System;
using FluentAssertions;
using GameBuddy.Stardew.Core.Algebra;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class ResultTests
{
    private sealed record CustomError(string Code, int Severity);

    [Fact]
    public void OkResult_PropertiesAndMap_WorkAsExpected()
    {
        var result = Result<int, string>.Ok(42);
        result.IsSuccess.Should().BeTrue();
        result.IsFailure.Should().BeFalse();
        result.Value.Should().Be(42);

        var mapped = result.Map(x => x.ToString());
        mapped.IsSuccess.Should().BeTrue();
        mapped.Value.Should().Be("42");
    }

    [Fact]
    public void ErrResult_FailCompatAliasAndMatch_WorkAsExpected()
    {
        var result = Result<int, string>.Fail("operation_failed");
        result.IsSuccess.Should().BeFalse();
        result.IsFailure.Should().BeTrue();
        result.Error.Should().Be("operation_failed");

        var matched = result.Match(v => $"ok:{v}", e => $"err:{e}");
        matched.Should().Be("err:operation_failed");
    }

    [Fact]
    public void DefaultStructResult_AccessingValueOrErrorOrMatch_ThrowsInvalidOperationException()
    {
        var defaultStringErr = default(Result<int, string>);
        defaultStringErr.IsSuccess.Should().BeFalse();
        defaultStringErr.IsFailure.Should().BeTrue();

        Action actErr = () => { var _ = defaultStringErr.Error; };
        Action actVal = () => { var _ = defaultStringErr.Value; };
        Action actMatch = () => { var _ = defaultStringErr.Match(v => "ok", e => "err"); };

        actErr.Should().Throw<InvalidOperationException>().WithMessage("*uninitialized*");
        actVal.Should().Throw<InvalidOperationException>().WithMessage("*uninitialized*");
        actMatch.Should().Throw<InvalidOperationException>().WithMessage("*uninitialized*");
    }

    [Fact]
    public void DefaultStructResult_CustomReferenceType_NeverThrowsOnMapOrBind()
    {
        var defaultCustom = default(Result<int, CustomError>);
        defaultCustom.IsSuccess.Should().BeFalse();
        defaultCustom.IsFailure.Should().BeTrue();

        var mapped = defaultCustom.Map(v => v * 2);
        mapped.IsFailure.Should().BeTrue();

        var bound = defaultCustom.Bind(v => Result<string, CustomError>.Ok($"val:{v}"));
        bound.IsFailure.Should().BeTrue();
    }

    [Fact]
    public void AccessingInvalidField_ThrowsInvalidOperationException()
    {
        var ok = Result<int, string>.Ok(10);
        var err = Result<int, string>.Err("error");

        Action actOkErr = () => { var _ = ok.Error; };
        Action actErrVal = () => { var _ = err.Value; };

        actOkErr.Should().Throw<InvalidOperationException>();
        actErrVal.Should().Throw<InvalidOperationException>();
    }
}
