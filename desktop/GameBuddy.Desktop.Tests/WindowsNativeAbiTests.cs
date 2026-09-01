using System.Runtime.InteropServices;

namespace GameBuddy.Desktop.Tests;

public sealed class WindowsNativeAbiTests
{
    [Fact]
    public void StartupInfoEx_has_the_native_pointer_sized_layout_required_by_CreateProcessW()
    {
        Assert.Equal(IntPtr.Size == 8 ? 104 : 68, Marshal.SizeOf<WindowsNative.StartupInfo>());
        Assert.Equal(IntPtr.Size == 8 ? 112 : 72, Marshal.SizeOf<WindowsNative.StartupInfoEx>());

        Assert.Equal(IntPtr.Size == 8 ? 72 : 52, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.lpReserved2)).ToInt32());
        Assert.Equal(IntPtr.Size == 8 ? 80 : 56, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.hStdInput)).ToInt32());
        Assert.Equal(IntPtr.Size == 8 ? 88 : 60, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.hStdOutput)).ToInt32());
        Assert.Equal(IntPtr.Size == 8 ? 96 : 64, Marshal.OffsetOf<WindowsNative.StartupInfo>(nameof(WindowsNative.StartupInfo.hStdError)).ToInt32());
        Assert.Equal(Marshal.SizeOf<WindowsNative.StartupInfo>(), Marshal.OffsetOf<WindowsNative.StartupInfoEx>(nameof(WindowsNative.StartupInfoEx.AttributeList)).ToInt32());
    }

    [Fact]
    public void Extended_length_path_preserves_the_admitted_absolute_target()
    {
        const string admitted = @"C:\\Users\\player\\AppData\\Local\\Programs\\GameBuddy\\generations\\g-mtiugve1-73288-0a0d298406044e94b65d4b9e4e0108d6\\native\\windows-stardew-bootstrap-guardian\\win-x64\\GameBuddy.WindowsStardewBootstrapGuardian.exe";

        Assert.Equal(@"\\?\" + admitted, WindowsNative.ToExtendedLengthPath(admitted));
        Assert.Equal(@"\\?\C:\\already-extended.exe", WindowsNative.ToExtendedLengthPath(@"\\?\C:\\already-extended.exe"));
    }

    [Fact]
    public void Supervisor_sets_cb_to_the_actual_StartupInfoEx_size()
    {
        var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "GuardianSupervisor.cs")));

        Assert.Contains("cb = (uint)Marshal.SizeOf<WindowsNative.StartupInfoEx>()", source, StringComparison.Ordinal);
        Assert.Contains("var executablePath = WindowsNative.ToExtendedLengthPath(image.VerifiedAbsolutePath)", source, StringComparison.Ordinal);
        Assert.Contains("new StringBuilder(Quote(executablePath))", source, StringComparison.Ordinal);
    }
}
