using System.Text;
using GameBuddy.Stardew.Core.Policy;

const string DeadlineWindowsArgument = "--deadline-windows";

if (args.Length > 1 || (args.Length == 1 && args[0] != DeadlineWindowsArgument))
{
    Console.Error.WriteLine("action_surface_export_takes_no_arguments");
    return 2;
}

try
{
    Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
    Console.Out.Write(args.Length == 1
        ? FarmhandActionDeadlineWindowExport.SerializeToJson()
        : FarmhandActionSurfaceExport.SerializeToJson());
    return 0;
}
catch (InvalidOperationException exception)
{
    Console.Error.WriteLine($"action_surface_export_invalid_catalog:{exception.Message}");
    return 1;
}
