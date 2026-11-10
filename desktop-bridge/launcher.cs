using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Launcher
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args)
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string configPath = Path.Combine(baseDir, "codex-webui-bridge.config");
            string[] config = File.ReadAllLines(configPath, Encoding.UTF8);
            if (config.Length != 5 || config[0] != "version=3")
            {
                throw new InvalidDataException("Bridge config must contain the Windows runtime paths for version 3.");
            }

            if (args.Length == 2 && args[0] == "--pipe-client")
                return VerifiedPipeClient.Run(args[1], config[1], config[2]);

            var startInfo = CreateRedirectedStartInfo(
                config[1],
                JoinArguments(config[2], args),
                config[3]);
            startInfo.EnvironmentVariables["CODEX_WEBUI_DATA_DIR"] = config[4];
            startInfo.EnvironmentVariables["CODEX_DESKTOP_BRIDGE_HOST"] = "windows";
            startInfo.EnvironmentVariables["CODEX_DESKTOP_BRIDGE_TRANSPORT"] = "pipe";

            using (Process child = Process.Start(startInfo))
            {
                if (child == null) throw new InvalidOperationException("Failed to start the Desktop bridge runtime.");
                IntPtr job = CreateKillOnCloseJob();
                try
                {
                    if (job != IntPtr.Zero) AssignProcessToJobObject(job, child.Handle);
                    Thread stdin = StartCopyThread(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
                    Thread stdout = StartCopyThread(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
                    Thread stderr = StartCopyThread(child.StandardError.BaseStream, Console.OpenStandardError(), false);
                    child.WaitForExit();
                    stdout.Join();
                    stderr.Join();
                    return child.ExitCode;
                }
                finally
                {
                    if (job != IntPtr.Zero) CloseHandle(job);
                }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[codex-webui-bridge-launcher] " + error);
            return 1;
        }
    }

    private static ProcessStartInfo CreateRedirectedStartInfo(string fileName, string arguments, string workingDirectory)
    {
        return new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
    }

    private static Thread StartCopyThread(Stream source, Stream destination, bool closeDestination)
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
            catch (IOException)
            {
                // The opposite endpoint closed normally.
            }
            finally
            {
                if (closeDestination)
                {
                    try { destination.Close(); } catch { }
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static string JoinArguments(string scriptPath, string[] args)
    {
        var builder = new StringBuilder();
        AppendQuoted(builder, scriptPath);
        foreach (string arg in args)
        {
            builder.Append(' ');
            AppendQuoted(builder, arg);
        }
        return builder.ToString();
    }

    private static void AppendQuoted(StringBuilder builder, string value)
    {
        builder.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            builder.Append(character);
            backslashes = 0;
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }
}
