namespace GameBuddy.Setup;

internal enum SetupOperation
{
    Install,
    Uninstall,
}

internal sealed record SetupRequest(
    SetupOperation Operation,
    string? LocalApplicationData,
    string? DisplayVersion,
    bool PurgeData)
{
    internal static SetupRequest Parse(string[] args)
    {
        var operation = SetupOperation.Install;
        string? localApplicationData = null;
        string? displayVersion = null;
        var purgeData = false;
        var operationSeen = false;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "install":
                    if (operationSeen) throw new SetupException(SetupFailure.UsageInvalid);
                    operationSeen = true;
                    operation = SetupOperation.Install;
                    break;
                case "uninstall":
                case "--uninstall":
                    if (operationSeen) throw new SetupException(SetupFailure.UsageInvalid);
                    operationSeen = true;
                    operation = SetupOperation.Uninstall;
                    break;
                case "--local-application-data":
                    localApplicationData = NextValue(args, ref index);
                    break;
                case "--version":
                    displayVersion = NextValue(args, ref index);
                    break;
                case "--purge":
                    purgeData = true;
                    break;
                default:
                    throw new SetupException(SetupFailure.UsageInvalid);
            }
        }

        if (purgeData && operation != SetupOperation.Uninstall)
        {
            throw new SetupException(SetupFailure.UsageInvalid);
        }

        return new SetupRequest(operation, localApplicationData, displayVersion, purgeData);
    }

    private static string NextValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1]))
        {
            throw new SetupException(SetupFailure.UsageInvalid);
        }

        return args[++index];
    }
}
