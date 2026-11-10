using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// A short-lived filesystem lease only. No Codex protocol, credentials or login.
// Directory handles deny write/delete sharing to prevent junction retargeting
// and ancestor replacement while Node enumerates or reads the pinned path.
class FileLease {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, highSize, lowSize, links, highIndex, lowIndex;
  }
  static readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
  static void Pin(string value, bool directory) {
    var handle = CreateFile(value, 0x80, directory ? 1u : 3u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new IOException(); }
    handles.Add(handle);
    Info info;
    if (!GetFileInformationByHandle(handle, out info) || (info.attributes & 0x400) != 0 || ((info.attributes & 0x10) != 0) != directory || (!directory && info.links != 1)) throw new IOException();
    var final = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
    if (length == 0 || length >= final.Capacity) throw new IOException();
    var resolved = final.ToString();
    if (resolved.StartsWith("\\\\?\\")) resolved = resolved.Substring(4);
    string expected = Path.GetFullPath(value).TrimEnd('\\');
    resolved = resolved.TrimEnd('\\');
    expected = Char.ToUpperInvariant(expected[0]) + expected.Substring(1);
    resolved = Char.ToUpperInvariant(resolved[0]) + resolved.Substring(1);
    if (!String.Equals(expected, resolved, StringComparison.Ordinal)) throw new IOException();
  }
  static int Main() {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    using (var deadline = new Timer(_ => Environment.Exit(3), null, 600000, Timeout.Infinite)) {
      try {
        string input = Console.ReadLine();
        if (input == null || input.Length > 16384) return 2;
        var request = new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(input);
        string root = Path.GetFullPath(request["root"]), relative = request["relative"];
        if (root.StartsWith("\\\\") || relative.Contains("\\") || relative.Contains(":") || relative.Contains("\0")) return 2;
        string volume = Path.GetPathRoot(root);
        if (volume.Length != 3 || String.Equals(root.TrimEnd('\\'), volume.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return 2;
        string current = volume;
        Pin(current, true);
        foreach (var part in root.Substring(volume.Length).Split('\\')) {
          if (part.Length == 0 || part == "." || part == "..") return 2;
          current = Path.Combine(current, part); Pin(current, true);
        }
        if (relative.Length > 0) {
          var parts = relative.Split('/');
          for (int i=0; i<parts.Length; i++) {
            var part = parts[i];
            if (part.Length == 0 || part == "." || part == ".." || part.TrimEnd(' ', '.') != part) return 2;
            current = Path.Combine(current, part);
            Pin(current, i < parts.Length-1 || request["kind"] == "directory");
          }
        }
        Console.WriteLine("READY"); Console.Out.Flush();
        Console.ReadLine();
        return 0;
      } catch { Console.WriteLine("DENIED"); return 2; }
      finally { for (int i=handles.Count-1; i>=0; i--) handles[i].Dispose(); }
    }
  }
}
