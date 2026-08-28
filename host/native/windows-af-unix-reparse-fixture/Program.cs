using System.Net.Sockets;
using System.Text;

if (!OperatingSystem.IsWindows() || args.Length != 1 || !Path.IsPathFullyQualified(args[0]))
    return 2;

try
{
    using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
    socket.Bind(new UnixDomainSocketEndPoint(args[0]));
    Console.Out.Write("ready\n");
    Console.Out.Flush();
    using var input = Console.OpenStandardInput();
    while (input.ReadByte() >= 0) { }
    return 0;
}
catch
{
    return 2;
}
