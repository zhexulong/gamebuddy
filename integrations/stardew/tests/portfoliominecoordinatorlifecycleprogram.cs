using GameBuddy.Stardew;

try
{
    PortfolioMineCoordinatorLifecycleContract.Run();
    Console.WriteLine("PortfolioMineCoordinatorLifecycle contract passed.");
    return 0;
}
catch (Exception exception)
{
    Console.Error.WriteLine(exception);
    return 1;
}
