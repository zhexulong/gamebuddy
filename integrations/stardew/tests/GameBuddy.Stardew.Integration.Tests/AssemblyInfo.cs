using Xunit;

// The WIA world/body projection (WorldModel) reads Game1 statics
// (activeClickableMenu / eventUp / timeOfDay) from inside
// ExecutionManager.Update and AdmitExecution — i.e. every integration test
// that drives an execution or an admission consumes those shared statics.
// xUnit's default per-class parallelization therefore races whatever the few
// writer fixtures set (reproduced 2026-10-03: two failures that swap identity
// run to run, each green in isolation). Serializing the whole assembly is the
// honest fix: the suite is execution-state-centric, not parallel-safe by
// design, and the per-class opt-out cannot enumerate every future reader.
[assembly: CollectionBehavior(DisableTestParallelization = true)]