using System.Text.Json;

// The nominated program of the launcher's dev/QA browser hook, as a test sees it. It records
// exactly the arguments it was started with and does nothing else: the launcher hands an entry over
// as one argv element of a directly started process, so this array is the whole truth about how the
// entry crossed that boundary, and a claim that the entry is one argument is falsifiable against a
// real process rather than against the launcher's own account of itself.
var report = Path.Combine(AppContext.BaseDirectory, "nominated-program-invocation.jsonl");
File.AppendAllText(report, JsonSerializer.Serialize(args) + Environment.NewLine);
