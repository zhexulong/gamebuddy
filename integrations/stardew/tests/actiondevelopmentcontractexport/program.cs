using GameBuddy.Stardew.Core.Policy;

if (args.Length != 1)
{
    Console.Error.WriteLine("action_development_contract_export_usage");
    return 2;
}

try
{
    ActionDevelopmentContract contract = FarmhandActionDevelopmentContract.DeriveContract(args[0]);
    Console.Out.Write(FarmhandActionDevelopmentContract.SerializeToJson(contract));
    Console.Out.Write('\n');
    return 0;
}
catch (ArgumentException)
{
    Console.Error.WriteLine("action_development_contract_export_invalid_action");
    return 2;
}
catch (KeyNotFoundException)
{
    Console.Error.WriteLine("action_development_contract_export_unknown_action");
    return 2;
}
