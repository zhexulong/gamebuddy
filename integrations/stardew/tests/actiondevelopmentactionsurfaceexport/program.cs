using System.Text;
using GameBuddy.Stardew.Core.Policy;

const string DeadlineWindowsArgument = "--deadline-windows";
const string HandlerGroupsArgument = "--handler-groups";

if (args.Length > 1)
{
    Console.Error.WriteLine("action_surface_export_takes_at_most_one_argument");
    return 2;
}

string? argument = args.Length == 1 ? args[0] : null;
if (argument is not null && argument != DeadlineWindowsArgument && argument != HandlerGroupsArgument)
{
    Console.Error.WriteLine("action_surface_export_unknown_argument");
    return 2;
}

try
{
    Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
    Console.Out.Write(argument switch
    {
        DeadlineWindowsArgument => FarmhandActionDeadlineWindowExport.SerializeToJson(),
        HandlerGroupsArgument => FarmhandActionHandlerGroupExport.SerializeToJson(),
        _ => FarmhandActionSurfaceExport.SerializeToJson(),
    });
    return 0;
}
catch (InvalidOperationException exception)
{
    Console.Error.WriteLine($"action_surface_export_invalid_catalog:{exception.Message}");
    return 1;
}
