using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

// Captures a window's own content, even when it is not in the foreground and even when it is a
// DirectComposition/RDP surface. `PrintWindow` with PW_RENDERFULLCONTENT (0x2) asks the window to
// render itself into a device context. That matters here because a Windows Sandbox window is a bitmap
// to the host's UI automation, and screenshots of the desktop only capture whatever is on top - so
// without this there is no way to see what the guest is actually showing (an error dialog, a flashing
// console, a desktop).
public static class WindowCapture
{
    public delegate bool EnumProc(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr handle, IntPtr deviceContext, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);

    /// <summary>
    /// Restores a window and asks for the foreground. The request can be refused while another
    /// application owns the foreground, so the result is reported rather than assumed.
    /// </summary>
    public static bool BringToFront(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return false;
        ShowWindow(handle, 9);
        return SetForegroundWindow(handle);
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

    /// <summary>
    /// Renders the window into an image and saves it. Returns a status line naming what happened, so a
    /// caller cannot mistake an empty capture for a successful one.
    /// </summary>
    public static string Capture(IntPtr handle, string path)
    {
        if (handle == IntPtr.Zero) return "capture_skipped:no_window";

        Rect rect;
        if (!GetWindowRect(handle, out rect)) return "capture_skipped:no_rect";
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return "capture_skipped:empty_rect";

        using (var bitmap = new Bitmap(width, height))
        {
            using (var graphics = Graphics.FromImage(bitmap))
            {
                var deviceContext = graphics.GetHdc();
                try
                {
                    // 0x2 = PW_RENDERFULLCONTENT, required for composited surfaces.
                    if (!PrintWindow(handle, deviceContext, 0x2)) return "capture_failed:print_window";
                }
                finally
                {
                    graphics.ReleaseHdc(deviceContext);
                }
            }
            bitmap.Save(path, ImageFormat.Png);
        }
        return "captured:" + path + " (" + width + "x" + height + ")";
    }
}
