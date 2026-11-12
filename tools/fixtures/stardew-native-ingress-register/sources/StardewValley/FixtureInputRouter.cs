namespace Fixture
{
    internal static class FixtureInputRouter
    {
        public static void PressInput(bool input)
        {
            if (input) PublishTransition();
        }

        private static void PublishTransition() { }
    }
}
