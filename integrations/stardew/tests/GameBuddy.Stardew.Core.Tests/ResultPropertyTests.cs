using System;
using FsCheck;
using FsCheck.Xunit;
using GameBuddy.Stardew.Core.Algebra;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class ResultPropertyTests
{
    [Property(MaxTest = 100)]
    public Property Monad_LeftIdentityLaw(int x)
    {
        Func<int, Result<int, string>> f = v => v >= 0
            ? Result<int, string>.Ok(v * 2)
            : Result<int, string>.Err("negative");

        var res1 = Result<int, string>.Ok(x).Bind(f);
        var res2 = f(x);
        return (res1.Equals(res2)).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Monad_RightIdentityLaw_OkAndErr(bool isSuccess, int val, NonEmptyString err)
    {
        var m = isSuccess ? Result<int, string>.Ok(val) : Result<int, string>.Err(err.Get);
        var res = m.Bind(Result<int, string>.Ok);
        return (res.Equals(m)).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Monad_AssociativityLaw_OkAndErr(bool isSuccess, int val, NonEmptyString err)
    {
        Func<int, Result<int, string>> f = v => v % 2 == 0 ? Result<int, string>.Ok(v / 2) : Result<int, string>.Err("odd");
        Func<int, Result<int, string>> g = v => v < 100 ? Result<int, string>.Ok(v + 10) : Result<int, string>.Err("too_large");

        var m = isSuccess ? Result<int, string>.Ok(val) : Result<int, string>.Err(err.Get);

        var left = m.Bind(f).Bind(g);
        var right = m.Bind(v => f(v).Bind(g));
        return (left.Equals(right)).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property Functor_IdentityAndCompositionLaws(bool isSuccess, int val, NonEmptyString err)
    {
        Func<int, int> f = v => v + 5;
        Func<int, string> g = v => $"val:{v}";

        var m = isSuccess ? Result<int, string>.Ok(val) : Result<int, string>.Err(err.Get);

        var identityPass = m.Map(x => x).Equals(m);
        var compositionPass = m.Map(f).Map(g).Equals(m.Map(x => g(f(x))));

        return (identityPass && compositionPass).ToProperty();
    }

    [Property(MaxTest = 100)]
    public Property DefaultStruct_NeverThrows_AndRemainsFailure(int offset)
    {
        var defaultResult = default(Result<int, string>);
        var mapped = defaultResult.Map(v => v + offset);
        var bound = defaultResult.Bind(v => Result<int, string>.Ok(v + offset));

        bool isMappedFailure = mapped.IsFailure && !mapped.IsSuccess;
        bool isBoundFailure = bound.IsFailure && !bound.IsSuccess;

        return (isMappedFailure && isBoundFailure).ToProperty();
    }
}
