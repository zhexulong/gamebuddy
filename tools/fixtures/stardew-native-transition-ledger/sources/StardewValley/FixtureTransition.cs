namespace Fixture
{
    internal static class FixtureTransition
    {
        public static void Route() { Commit(); }
        public static void Commit() { }
        public static void Resume() { }
        public static void Gap() { }
    }
}
