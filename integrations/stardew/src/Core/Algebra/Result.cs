// integrations/stardew/src/Core/Algebra/Result.cs
using System;
using System.Diagnostics.CodeAnalysis;

namespace GameBuddy.Stardew.Core.Algebra;

[SuppressMessage("Design", "CA1000:Do not declare static members on generic types", Justification = "Ergonomic railway result constructors avoiding FsCheck namespace collisions")]
[SuppressMessage("Naming", "CA1715:Identifiers should have correct prefix", Justification = "Standard FP generic parameter naming")]
public readonly record struct Result<TValue, TError>
{
    private readonly TValue? _value;
    private readonly TError? _error;
    private readonly bool _initialized;

    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;

    private Result(TValue value)
    {
        _initialized = true;
        IsSuccess = true;
        _value = value;
        _error = default;
    }

    private Result(TError error, bool _)
    {
        ArgumentNullException.ThrowIfNull(error);
        _initialized = true;
        IsSuccess = false;
        _value = default;
        _error = error;
    }

    public static Result<TValue, TError> Ok(TValue value) => new(value);
    public static Result<TValue, TError> Err(TError error) => new(error, false);
    public static Result<TValue, TError> Fail(TError error) => new(error, false);

    public TValue Value => _initialized && IsSuccess
        ? _value!
        : throw new InvalidOperationException(_initialized ? "Cannot access Value on Failure Result" : "Cannot access Value on uninitialized Result");

    public TError Error => _initialized && !IsSuccess
        ? _error!
        : throw new InvalidOperationException(_initialized ? "Cannot access Error on Success Result" : "Cannot access Error on uninitialized Result");

    public Result<TOut, TError> Map<TOut>(Func<TValue, TOut> map)
    {
        ArgumentNullException.ThrowIfNull(map);
        if (!_initialized) return default;
        return IsSuccess ? Result<TOut, TError>.Ok(map(_value!)) : Result<TOut, TError>.Err(_error!);
    }

    public Result<TOut, TError> Bind<TOut>(Func<TValue, Result<TOut, TError>> bind)
    {
        ArgumentNullException.ThrowIfNull(bind);
        if (!_initialized) return default;
        return IsSuccess ? bind(_value!) : Result<TOut, TError>.Err(_error!);
    }

    public TOut Match<TOut>(Func<TValue, TOut> onSuccess, Func<TError, TOut> onFailure)
    {
        ArgumentNullException.ThrowIfNull(onSuccess);
        ArgumentNullException.ThrowIfNull(onFailure);
        if (!_initialized) throw new InvalidOperationException("Cannot match on uninitialized Result");
        return IsSuccess ? onSuccess(_value!) : onFailure(_error!);
    }
}
