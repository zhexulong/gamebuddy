using System.Text;
using GameBuddy.Stardew.Core.Policy;

if (args.Length != 0) { Console.Error.WriteLine("action_surface_export_takes_no_arguments"); return 2; }
try { Console.OutputEncoding = new UTF8Encoding(false); Console.Out.Write(FarmhandActionSurfaceExport.SerializeToJson()); return 0; }
catch (InvalidOperationException exception) { Console.Error.WriteLine($"action_surface_export_invalid_catalog:{exception.Message}"); return 1; }
