using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class VerifiedPipeClient
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static int Run(string pipePath, string expectedNode, string expectedBroker)
    {
        const string prefix = @"\\.\pipe\";
        if (!pipePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Pipe peer verification requires a local Windows named pipe.");
        string name = pipePath.Substring(prefix.Length);
        if (name.Length == 0 || name.IndexOfAny(new char[] { '\\', '/' }) >= 0)
            throw new InvalidDataException("Invalid local pipe name.");
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous))
        {
            pipe.Connect(5000);
            VerifyPeer(pipe, expectedNode, expectedBroker);
            Console.Error.WriteLine("CODEX_PIPE_VERIFIED");
            Console.Error.Flush();
            CopyInBackground(Console.OpenStandardInput(), pipe, true);
            Thread output = CopyInBackground(pipe, Console.OpenStandardOutput(), false);
            output.Join();
        }
        return 0;
    }

    private static void VerifyPeer(NamedPipeClientStream pipe, string expectedNode, string expectedBroker)
    {
        uint pid;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify pipe peer PID.");
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify pipe peer process.");
        try
        {
            var image = new StringBuilder(32768);
            uint size = (uint)image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref size) || !SamePath(image.ToString(), expectedNode))
                throw new InvalidDataException("Pipe peer executable does not match the Desktop broker runtime.");
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify pipe peer user.");
            try
            {
                using (var peer = new WindowsIdentity(token))
                using (var self = WindowsIdentity.GetCurrent())
                {
                    if (peer.User == null || self.User == null || !peer.User.Equals(self.User))
                        throw new InvalidDataException("Pipe peer user identity does not match.");
                }
            }
            finally { CloseHandle(token); }
            string commandLine;
            using (var query = new ManagementObject("Win32_Process.Handle='" + pid + "'"))
            {
                query.Get();
                commandLine = query["CommandLine"] as string;
            }
            int count;
            IntPtr arguments = CommandLineToArgvW(commandLine ?? "", out count);
            if (arguments == IntPtr.Zero) throw new InvalidDataException("Cannot parse pipe peer command line.");
            try
            {
                string script = count > 1 ? Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, IntPtr.Size)) : null;
                if (String.IsNullOrEmpty(script) || !Path.IsPathRooted(script) || !SamePath(script, expectedBroker))
                    throw new InvalidDataException("Pipe peer is not the expected Desktop broker program.");
            }
            finally { LocalFree(arguments); }
        }
        finally { CloseHandle(process); }
    }

    private static bool SamePath(string left, string right)
    {
        return String.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
    }

    private static Thread CopyInBackground(Stream source, Stream destination, bool closeDestination)
    {
        var thread = new Thread(delegate()
        {
            try
            {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                {
                    destination.Write(buffer, 0, count);
                    destination.Flush();
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            finally { if (closeDestination) { try { destination.Close(); } catch (IOException) { } } }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
}
