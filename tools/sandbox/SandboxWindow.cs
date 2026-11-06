using System;
using System.Text;
using System.Runtime.InteropServices;

public static class SandboxWindow
{
    public delegate bool EnumProc(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder text, int capacity);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static IntPtr FindByTitle(string title)
    {
        var found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr handle, IntPtr parameter)
        {
            var text = new StringBuilder(512);
            GetWindowText(handle, text, text.Capacity);
            if (IsWindowVisible(handle) && string.Equals(text.ToString(), title, StringComparison.Ordinal))
            {
                found = handle;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string Describe(IntPtr handle)
    {
        var text = new StringBuilder(512);
        GetWindowText(handle, text, text.Capacity);
        var className = new StringBuilder(256);
        GetClassName(handle, className, className.Capacity);
        return handle + "|" + text + "|" + className + "|visible=" + IsWindowVisible(handle);
    }

    public static void BringToFront(IntPtr handle)
    {
        ShowWindow(handle, 9);
        SetForegroundWindow(handle);
    }

    public static bool TryGetRect(IntPtr handle, out int left, out int top, out int width, out int height)
    {
        left = top = width = height = 0;
        Rect rect;
        if (!GetWindowRect(handle, out rect)) return false;
        left = rect.Left;
        top = rect.Top;
        width = rect.Right - rect.Left;
        height = rect.Bottom - rect.Top;
        return width > 100 && height > 100;
    }
}
