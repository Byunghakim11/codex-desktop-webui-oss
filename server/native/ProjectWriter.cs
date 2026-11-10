using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Short-lived Windows project writer. No Codex protocol, credentials or user content in argv.
// Private length-delimited stdio protocol: Prepare -> Prepared -> Commit|Abort -> Result|Error.
class ProjectWriter {
  const int PROTOCOL_VERSION = 1;
  const int MAX_PREPARE = 65536;
  const int MAX_CONTROL = 16384;
  const long MAX_RESULT = 16L * 1024 * 1024;
  const long MAX_UPLOAD = 25L * 1024 * 1024;
  const long MAX_TEXT = 1L * 1024 * 1024;
  const long RECOVERY_QUOTA = 64L * 1024 * 1024;
  const int RECOVERY_MAX_FILES = 128;
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, DELETE = 0x00010000, FILE_READ_ATTRIBUTES = 0x80;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint OPEN_EXISTING = 3, CREATE_NEW = 1;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_NORMAL = 0x80, FILE_ATTRIBUTE_REPARSE_POINT = 0x400, FILE_ATTRIBUTE_DIRECTORY = 0x10;
  const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_ACCESS_DENIED = 5, ERROR_SHARING_VIOLATION = 32,
    ERROR_LOCK_VIOLATION = 33, ERROR_FILE_EXISTS = 80, ERROR_ALREADY_EXISTS = 183;
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  static readonly List<SafeFileHandle> pinned = new List<SafeFileHandle>();

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long position, uint method);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetEndOfFile(SafeFileHandle handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool FlushFileBuffers(SafeFileHandle handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateDirectory(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool RemoveDirectory(string path);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FileDispositionInfo info, int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeWaitHandle CreateMutex(IntPtr attributes, bool initialOwner, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReleaseMutex(SafeWaitHandle handle);
  [StructLayout(LayoutKind.Sequential)] struct FileDispositionInfo { public byte delete; }

  // Test-only fault/checkpoint hooks. The environment switch and the throwing/sleeping bodies are
  // compiled out unless the helper is built with /define:PROJECT_WRITER_TESTS, so a shipped helper
  // contains no way to enable faults (no field, no env, no argv).
  static bool Fault(string name) {
#if PROJECT_WRITER_TESTS
    string raw = Environment.GetEnvironmentVariable("PROJECT_WRITER_TEST_FAULT");
    if (raw == null) return false;
    string[] parts = raw.Split(',');
    for (int i = 0; i < parts.Length; i++) if (String.Equals(parts[i].Trim(), name, StringComparison.Ordinal)) return true;
#endif
    return false;
  }
  static void Pause(string name, int milliseconds) {
#if PROJECT_WRITER_TESTS
    if (Fault(name)) Thread.Sleep(milliseconds);
#endif
  }
  // Bounded test checkpoint: publishes a marker file and waits for a resume file, then continues.
  static void Checkpoint(string name) {
#if PROJECT_WRITER_TESTS
    if (!Fault("checkpoint:" + name)) return;
    string marker = Environment.GetEnvironmentVariable("PROJECT_WRITER_TEST_MARKER");
    string resume = Environment.GetEnvironmentVariable("PROJECT_WRITER_TEST_RESUME");
    if (marker == null || resume == null) return;
    File.WriteAllText(marker, "ready");
    for (int i = 0; i < 1000; i++) { if (File.Exists(resume)) return; Thread.Sleep(20); }
#endif
  }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, highSize, lowSize, links, highIndex, lowIndex;
  }

  static int Main() {
    Console.InputEncoding = Utf8; Console.OutputEncoding = Utf8;
    using (var deadline = new Timer(_ => Environment.Exit(3), null, 180000, Timeout.Infinite)) {
      try { Run(); return 0; }
      catch (WriterException error) { SendError(error); return 2; }
      catch { SendError(new WriterException("INTERNAL", 500, null)); return 2; }
      finally { for (int i = pinned.Count - 1; i >= 0; i--) pinned[i].Dispose(); }
    }
  }

  static void Run() {
    string header = ReadFrame(MAX_PREPARE);
    if (header == null) return;
    Dictionary<string, object> request = ParseObject(header);
    if (GetInt(request, "v") != PROTOCOL_VERSION || GetString(request, "t") != "prepare") Fail("PROTOCOL_ERROR", 400, null);
    PreparedState state = Prepare(request);
    try {
      Send(state.PreparedMessage());
      string controlJson = ReadFrame(MAX_CONTROL);
      if (controlJson == null) return;
      Dictionary<string, object> control = ParseObject(controlJson);
      RequireOnly(control, new string[] { "v", "t", "operationId" });
      if (GetInt(control, "v") != PROTOCOL_VERSION || GetString(control, "operationId") != state.OperationId) Fail("PROTOCOL_ERROR", 400, null);
      string type = GetString(control, "t");
      if (type == "abort") { Send(AbortAck(state)); return; }
      if (type != "commit") Fail("PROTOCOL_ERROR", 400, null);
      state.Commit();
      Send(state.ResultMessage());
    } finally { state.Dispose(); }
  }

  static PreparedState Prepare(Dictionary<string, object> request) {
    string kind = GetString(request, "kind");
    if (!(kind == "context" || kind == "mkdir" || kind == "upload" || kind == "edit-open" || kind == "save-text")) Fail("INVALID_OPERATION", 400, null);
    List<string> allowed = new List<string>(new string[] { "v", "t", "operationId", "kind", "root", "relativePath", "dataDir" });
    if (kind == "upload" || kind == "save-text") allowed.AddRange(new string[] { "stagedPath", "stagedHash", "stagedSize" });
    if (kind == "save-text") allowed.AddRange(new string[] { "expectedVersion", "recoveryBinding" });
    RequireOnly(request, allowed.ToArray());
    string operationId = GetString(request, "operationId");
    if (!IsHex(operationId, 32, true)) Fail("INVALID_OPERATION", 400, null);
    string root = GetString(request, "root");
    ValidateRoot(root);
    string relative = GetString(request, "relativePath");
    ValidateRelative(relative, kind == "context");
    string dataDir = ValidateDataDir(GetString(request, "dataDir"));
    string target = relative.Length == 0 ? root : Path.Combine(root, relative.Replace('/', '\\'));
    string parent = Path.GetDirectoryName(target);
    if (parent == null || !Inside(root, target) || (relative.Length > 0 && !Inside(root, parent))) Fail("PROJECT_UNAVAILABLE", 403, null);
    if (Inside(dataDir, root) || Inside(root, dataDir)) Fail("PROJECT_UNAVAILABLE", 403, null);

    PreparedState state = new PreparedState();
    state.OperationId = operationId; state.Kind = kind; state.Root = root; state.RelativePath = relative;
    state.TargetPath = target; state.ParentPath = parent; state.DataDir = dataDir;
    SafeFileHandle rootHandle = PinRootChain(root);
    Info rootInfo = InfoOf(rootHandle);
    state.RootIdentity = Identity(rootInfo);
    int slash = relative.LastIndexOf('/');
    string parentRelative = slash < 0 ? "" : relative.Substring(0, slash);

    if (kind == "context") {
      SafeFileHandle targetHandle = relative.Length == 0 ? rootHandle : PinRelative(root, relative);
      Info targetInfo = InfoOf(targetHandle);
      state.ParentIdentity = state.TargetIdentity = Identity(targetInfo);
      state.TargetPath = relative.Length == 0 ? root : target;
      state.ParentPath = state.TargetPath;
      state.Size = 0;
    } else {
      SafeFileHandle parentHandle = parentRelative.Length == 0 ? rootHandle : PinRelative(root, parentRelative);
      state.ParentIdentity = Identity(InfoOf(parentHandle));
    }

    if (kind == "mkdir") {
      EnsureAbsent(target);
    } else if (kind == "upload") {
      EnsureAbsent(target);
      long stagedSize = GetLong(request, "stagedSize");
      string stagedHash = GetString(request, "stagedHash");
      if (!IsHex(stagedHash, 64, true)) Fail("INVALID_OPERATION", 400, null);
      state.Stage = OpenStage(GetString(request, "stagedPath"), dataDir, stagedSize, stagedHash, MAX_UPLOAD);
      state.Add(state.Stage.Handle);
      state.Size = state.Stage.Size;
    } else if (kind == "edit-open") {
      OpenTextTarget(state, target, GENERIC_READ, FILE_SHARE_READ, true);
    } else if (kind == "save-text") {
      string expectedVersion = GetString(request, "expectedVersion");
      if (!IsVersion(expectedVersion)) Fail("VERSION_REQUIRED", 400, null);
      string binding = GetString(request, "recoveryBinding");
      if (!IsHex(binding, 64, true)) Fail("INVALID_OPERATION", 400, null);
      state.RecoveryBinding = binding;
      OpenTextTarget(state, target, GENERIC_READ | GENERIC_WRITE, 0, false);
      if (!state.Editable) Fail("NOT_EDITABLE", 415, null);
      if (!String.Equals(state.CurrentVersion, expectedVersion, StringComparison.Ordinal)) Fail("VERSION_CONFLICT", 409, null);
      long stagedSize = GetLong(request, "stagedSize");
      string stagedHash = GetString(request, "stagedHash");
      if (!IsHex(stagedHash, 64, true)) Fail("INVALID_OPERATION", 400, null);
      state.Stage = OpenStage(GetString(request, "stagedPath"), dataDir, stagedSize, stagedHash, MAX_TEXT);
      state.Add(state.Stage.Handle);
      state.StageText = ParseStage(state.Stage.Bytes);
      state.NewBytes = BuildSaveBytes(state, state.StageText);
      state.NewHash = Sha256(state.NewBytes);
      state.RecoveryId = Sha256Hex(Utf8.GetBytes(state.OperationId + "|" + state.RecoveryBinding + "|" + state.TargetIdentity + "|" + state.CurrentVersion));
    }
    return state;
  }

  static byte[] BuildSaveBytes(PreparedState state, string normalized) {
    string converted = state.Eol == "crlf" ? normalized.Replace("\n", "\r\n") : normalized;
    byte[] payload = Utf8.GetBytes(converted);
    byte[] bom = new byte[] { 0xef, 0xbb, 0xbf };
    long total = payload.Length + (state.Bom ? 3 : 0);
    if (total > MAX_TEXT) Fail("TOO_LARGE", 413, null);
    if (!state.Bom) return payload;
    byte[] all = new byte[(int)total];
    Buffer.BlockCopy(bom, 0, all, 0, 3);
    Buffer.BlockCopy(payload, 0, all, 3, payload.Length);
    return all;
  }

  static void OpenTextTarget(PreparedState state, string path, uint access, uint share, bool allowOversized) {
    Info info;
    SafeFileHandle handle = OpenFile(path, access, share, out info);
    state.Add(handle);
    state.TargetHandle = handle; state.TargetInfo = info; state.TargetIdentity = Identity(info);
    long size = Size(info); state.Size = size; state.OriginalSize = size;
    if (size > MAX_TEXT) {
      if (!allowOversized) Fail("TOO_LARGE", 413, null);
      state.Oversized = true; state.Editable = false; state.Reason = "SIZE_LIMIT"; state.Eol = "mixed"; state.Bom = false;
      return;
    }
    state.OriginalBytes = ReadAll(handle, size, MAX_TEXT);
    state.OriginalHash = Sha256(state.OriginalBytes);
    state.CurrentVersion = Version(state.TargetIdentity, state.OriginalHash);
    TextInfo text = ParseText(state.OriginalBytes);
    state.Bom = text.Bom; state.Eol = text.Eol; state.Editable = text.Editable; state.Reason = text.Reason; state.Text = text.Text;
  }

  static TextInfo ParseText(byte[] bytes) {
    TextInfo result = new TextInfo();
    result.Bom = bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf;
    int offset = result.Bom ? 3 : 0;
    string text;
    try { text = Utf8.GetString(bytes, offset, bytes.Length - offset); }
    catch { result.Editable = false; result.Reason = "ENCODING"; result.Eol = "mixed"; return result; }
    if (text.IndexOf('\0') >= 0) { result.Editable = false; result.Reason = "BINARY"; result.Eol = "mixed"; return result; }
    result.Text = text;
    int crlf = 0, lf = 0, lone = 0;
    for (int i = 0; i < text.Length; i++) {
      if (text[i] == '\r') {
        if (i + 1 < text.Length && text[i + 1] == '\n') { crlf++; i++; } else lone++;
      } else if (text[i] == '\n') lf++;
    }
    if (lone > 0) { result.Eol = "mixed"; result.Editable = false; result.Reason = "EOL_LONE_CR"; return result; }
    if (crlf > 0 && lf > 0) { result.Eol = "mixed"; result.Editable = false; result.Reason = "EOL_MIXED"; return result; }
    result.Eol = crlf > 0 ? "crlf" : "lf";
    result.Editable = true;
    return result;
  }

  static string ParseStage(byte[] bytes) {
    if (bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) Fail("STAGE_INVALID", 400, null);
    for (int i = 0; i < bytes.Length; i++) if (bytes[i] == 0) Fail("STAGE_INVALID", 400, null);
    string text;
    try { text = Utf8.GetString(bytes); } catch { Fail("STAGE_INVALID", 400, null); return null; }
    if (text.IndexOf('\r') >= 0) Fail("STAGE_INVALID", 400, null);
    return text;
  }

  class TextInfo { public bool Bom; public string Text; public string Eol; public bool Editable; public string Reason; }

  class StageData {
    public SafeFileHandle Handle; public Info Info; public byte[] Bytes; public string Hash; public long Size;
  }

  class PreparedState : IDisposable {
    public string OperationId, Kind, Root, RelativePath, TargetPath, ParentPath, DataDir;
    public string RootIdentity, ParentIdentity, TargetIdentity, CurrentVersion, RecoveryBinding, RecoveryId;
    public string OriginalHash, NewHash, StageText, BomText;
    public long Size, OriginalSize;
    public byte[] OriginalBytes, NewBytes;
    public SafeFileHandle TargetHandle;
    public Info TargetInfo;
    public StageData Stage;
    public bool Bom, Editable, Oversized;
    public string Eol, Reason, Text;
    public string RecoveryPath; public string RecoveryIdentity;
    public Dictionary<string, object> Result;
    readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
    public void Add(SafeFileHandle handle) { handles.Add(handle); }
    public void Dispose() { for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); }

    public Dictionary<string, object> PreparedMessage() {
      Dictionary<string, object> m = Common("prepared");
      m["rootIdentity"] = RootIdentity; m["parentIdentity"] = ParentIdentity;
      if (TargetIdentity != null) m["targetIdentity"] = TargetIdentity;
      if (CurrentVersion != null) m["currentVersion"] = CurrentVersion;
      if (Kind == "upload") m["size"] = Size;
      if (Kind == "edit-open") { m["size"] = Size; m["bom"] = Bom; m["eol"] = Eol; m["editable"] = Editable; m["reason"] = Reason; }
      if (Kind == "save-text") { m["currentVersion"] = CurrentVersion; m["newSize"] = NewBytes.Length; m["bom"] = Bom; m["eol"] = Eol; }
      return m;
    }
    public Dictionary<string, object> ResultMessage() { Dictionary<string, object> m = Common("result"); foreach (KeyValuePair<string, object> pair in Result) m[pair.Key] = pair.Value; return m; }
    Dictionary<string, object> Common(string type) {
      Dictionary<string, object> m = new Dictionary<string, object>();
      m["v"] = PROTOCOL_VERSION; m["t"] = type; m["operationId"] = OperationId; m["kind"] = Kind == "edit-open" || Kind == "upload" || Kind == "save-text" ? "file" : "directory";
      m["path"] = RelativePath; return m;
    }
    public void Commit() {
      RecheckBase();
      if (Kind == "context") CommitContext();
      else if (Kind == "mkdir") CommitMkdir();
      else if (Kind == "upload") CommitUpload();
      else if (Kind == "edit-open") CommitEdit();
      else if (Kind == "save-text") CommitSave();
      else Fail("INVALID_OPERATION", 400, null);
    }
    void RecheckBase() {
      if (!PathnameOurs(Root, RootIdentity, Root)) Fail("PROJECT_UNAVAILABLE", 403, null);
      if (!PathnameOurs(ParentPath, ParentIdentity, ParentPath)) Fail("PROJECT_UNAVAILABLE", 403, null);
    }
    void CommitContext() {
      if (TargetIdentity != null && !PathnameOurs(TargetPath, TargetIdentity, TargetPath)) Fail("PROJECT_UNAVAILABLE", 403, null);
      Result = new Dictionary<string, object>();
      Result["rootIdentity"] = RootIdentity; Result["parentIdentity"] = ParentIdentity; Result["targetIdentity"] = TargetIdentity;
    }
    void CommitMkdir() {
      if (!CreateDirectory(TargetPath, IntPtr.Zero)) {
        int code = Marshal.GetLastWin32Error();
        if (code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS || File.Exists(TargetPath) || Directory.Exists(TargetPath)) Fail("ALREADY_EXISTS", 409, null);
        Fail("PROJECT_UNAVAILABLE", 403, null);
      }
      string createdIdentity = null;
      try {
        Info info; SafeFileHandle created = OpenDirVerify(TargetPath, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, out info);
        createdIdentity = Identity(info); created.Dispose();
        if (!PathnameOurs(ParentPath, ParentIdentity, ParentPath)) throw new WriterException("PROJECT_UNAVAILABLE", 403, null);
        Result = new Dictionary<string, object>();
        Result["rootIdentity"] = RootIdentity; Result["parentIdentity"] = ParentIdentity; Result["targetIdentity"] = createdIdentity;
      } catch {
        if (createdIdentity != null) CleanupDirectory(TargetPath, createdIdentity);
        throw;
      }
    }
    void CommitUpload() {
      Info stageInfo = InfoOf(Stage.Handle);
      if (Identity(stageInfo) != Identity(Stage.Info)) Fail("STAGE_CHANGED", 409, null);
      byte[] stageBytes = ReadAll(Stage.Handle, Stage.Size, MAX_UPLOAD);
      if (Sha256(stageBytes) != Stage.Hash) Fail("STAGE_CHANGED", 409, null);
      // DELETE access is required so this owned CREATE_NEW handle can be closed with
      // delete-on-close when the write fails; cleanup is always by handle, never by path.
      SafeFileHandle handle = CreateFile(TargetPath, GENERIC_READ | GENERIC_WRITE | DELETE, 0, IntPtr.Zero, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
      if (handle.IsInvalid) {
        handle.Dispose(); int code = Marshal.GetLastWin32Error();
        if (code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS || File.Exists(TargetPath) || Directory.Exists(TargetPath)) Fail("ALREADY_EXISTS", 409, null);
        Fail("PROJECT_UNAVAILABLE", 403, null);
      }
      Add(handle);
      Info info; string identity = null;
      if (GetFileInformationByHandle(handle, out info)) identity = Identity(info);
      if (identity == null || (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || info.links != 1 || !SamePath(TargetPath, FinalPath(handle))) {
        FailUpload(handle, identity, "FILE_RESTRICTED", 403);
      }
      try { WriteAll(handle, stageBytes, "upload-write"); }
      catch { FailUpload(handle, identity, "IO_ERROR", 500); }
      byte[] verify = null;
      try { verify = ReadAll(handle, stageBytes.Length, MAX_UPLOAD); }
      catch { FailUpload(handle, identity, "IO_ERROR", 500); }
      if (verify == null || Sha256(verify) != Stage.Hash) FailUpload(handle, identity, "IO_ERROR", 500);
      // The pathname now belongs to another object: our owned file is reported by identity, never
      // path-deleted and never restored over the new name.
      if (!PathnameOurs(TargetPath, identity, TargetPath)) Fail("NAME_REPLACED", 409, CleanupId(), identity);
      Result = new Dictionary<string, object>();
      Result["rootIdentity"] = RootIdentity; Result["parentIdentity"] = ParentIdentity; Result["targetIdentity"] = identity;
      Result["size"] = Stage.Size; Result["version"] = Version(identity, Stage.Hash);
    }
    // Disposition failure is reported as a distinct owned-cleanup state (identity of our object),
    // not as an ordinary no-leftover failure.
    void FailUpload(SafeFileHandle handle, string identity, string code, int status) {
      if (MarkDelete(handle)) Fail(code, status, null);
      Fail("CLEANUP_REQUIRED", 500, CleanupId(), identity);
    }
    string CleanupId() { return Sha256Hex(Utf8.GetBytes(OperationId + "|owned-cleanup|" + RelativePath)); }
    void CommitEdit() {
      if (!PathnameOurs(TargetPath, TargetIdentity, TargetPath)) Fail("NAME_REPLACED", 409, null);
      Info info = InfoOf(TargetHandle);
      if (Identity(info) != TargetIdentity) Fail("FILE_CHANGED", 409, null);
      Result = new Dictionary<string, object>();
      Result["rootIdentity"] = RootIdentity; Result["parentIdentity"] = ParentIdentity; Result["targetIdentity"] = TargetIdentity;
      Result["size"] = Size;
      if (Oversized) {
        Result["text"] = null; Result["version"] = null; Result["bom"] = false; Result["eol"] = "mixed"; Result["editable"] = false; Result["reason"] = "SIZE_LIMIT";
        return;
      }
      byte[] bytes;
      try { bytes = ReadAll(TargetHandle, OriginalSize, MAX_TEXT); }
      catch { Fail("IO_ERROR", 500, null); return; }
      string hash = Sha256(bytes);
      if (hash != OriginalHash) Fail("VERSION_CONFLICT", 409, null);
      TextInfo text = ParseText(bytes);
      Result["text"] = text.Editable ? text.Text : null; Result["version"] = Version(TargetIdentity, hash);
      Result["bom"] = text.Bom; Result["eol"] = text.Eol; Result["editable"] = text.Editable; Result["reason"] = text.Reason;
    }
    void CommitSave() {
      RequireNameOurs(null);
      Info info = InfoOf(TargetHandle);
      if (Identity(info) != TargetIdentity) Fail("FILE_CHANGED", 409, null);
      byte[] current;
      try { current = ReadAll(TargetHandle, OriginalSize, MAX_TEXT); }
      catch { Fail("IO_ERROR", 500, null); return; }
      if (Sha256(current) != OriginalHash) Fail("VERSION_CONFLICT", 409, null);
      TextInfo text = ParseText(current);
      if (!text.Editable) Fail("NOT_EDITABLE", 415, null);
      string normalized = ParseStage(Stage.Bytes);
      byte[] newBytes = BuildSaveBytes(this, normalized);
      string newHash = Sha256(newBytes);
      CreateRecovery();
      Pause("hold-recovery", 900);
      bool written = false;
      try {
        WriteAll(TargetHandle, newBytes, "save-write");
        byte[] verify = ReadAll(TargetHandle, newBytes.Length, MAX_TEXT);
        if (Sha256(verify) != newHash) throw new IOException();
        written = true;
      } catch {
        // A name replacement is never undone and never written over: the recovery record stays.
        Checkpoint("rollback-name-check");
        if (!PathnameOurs(TargetPath, TargetIdentity, TargetPath)) Fail("NAME_REPLACED", 409, RecoveryId);
        try {
          WriteAll(TargetHandle, OriginalBytes, "save-rollback");
          byte[] verify = ReadAll(TargetHandle, OriginalBytes.Length, MAX_TEXT);
          if (Sha256(verify) != OriginalHash) throw new IOException();
        } catch { Fail("ROLLBACK_FAILED", 500, RecoveryId); }
        Fail("WRITE_FAILED", 500, RecoveryId);
      }
      if (written) {
        Checkpoint("postwrite-name-check");
        if (!PathnameOurs(TargetPath, TargetIdentity, TargetPath)) Fail("NAME_REPLACED", 409, RecoveryId);
      }
#if PROJECT_WRITER_TESTS
      if (Fault("crash-before-recovery-delete")) Environment.Exit(4);
#endif
      bool cleared = DeleteRecovery();
      Result = new Dictionary<string, object>();
      Result["rootIdentity"] = RootIdentity; Result["parentIdentity"] = ParentIdentity; Result["targetIdentity"] = TargetIdentity;
      Result["newVersion"] = Version(TargetIdentity, newHash); Result["version"] = Version(TargetIdentity, newHash);
      Result["size"] = newBytes.Length; Result["bom"] = text.Bom; Result["eol"] = text.Eol;
      if (!cleared) { Result["recoveryPending"] = true; Result["recoveryId"] = RecoveryId; }
    }
    void RequireNameOurs(string recoveryId) {
      if (!PathnameOurs(TargetPath, TargetIdentity, TargetPath)) Fail("NAME_REPLACED", 409, recoveryId);
    }
    // Reservation is the first mutation: while holding a per-dataDir named mutex we enumerate every
    // existing recovery, include our own backup size, then create+flush+validate our record. Other
    // helper processes see our record before they can pass the same check. Nothing is ever evicted.
    void CreateRecovery() {
      string parent = Path.Combine(DataDir, "project-writes");
      string dir = Path.Combine(parent, "recoveries");
      Directory.CreateDirectory(parent); Directory.CreateDirectory(dir);
      Info dirInfo; SafeFileHandle dirHandle = OpenDirVerify(dir, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, out dirInfo); dirHandle.Dispose();
      byte[] header = RecoveryHeader();
      long backupSize = (long)header.Length + OriginalBytes.Length;
      if (backupSize > RECOVERY_QUOTA) Fail("RECOVERY_QUOTA", 507, null);
      string path = Path.Combine(dir, "recovery-" + RecoveryId + ".bin");
      using (QuotaReservation reservation = QuotaReservation.Acquire(DataDir)) {
        long total = 0; int count = 0;
        string[] files = Directory.GetFiles(dir, "recovery-*.bin");
        for (int i = 0; i < files.Length; i++) {
          count++;
          try { total += new FileInfo(files[i]).Length; } catch { total += MAX_TEXT + 65536; }
        }
        if (count + 1 > RECOVERY_MAX_FILES || total + backupSize > RECOVERY_QUOTA) Fail("RECOVERY_QUOTA", 507, null);
        SafeFileHandle handle = CreateFile(path, GENERIC_READ | GENERIC_WRITE | DELETE, 0, IntPtr.Zero, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); Fail("RECOVERY_REQUIRED", 500, null); }
        try {
          byte[] all = new byte[backupSize];
          Buffer.BlockCopy(header, 0, all, 0, header.Length); Buffer.BlockCopy(OriginalBytes, 0, all, header.Length, OriginalBytes.Length);
          WriteAll(handle, all, "recovery-write");
          Info info = InfoOf(handle);
          if (Size(info) != backupSize || info.links != 1 || (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || !SamePath(path, FinalPath(handle))) throw new IOException();
          RecoveryIdentity = Identity(info); RecoveryPath = path;
        } catch {
          string owned = RecoveryIdentity;
          if (!MarkDelete(handle)) { handle.Dispose(); Fail("CLEANUP_REQUIRED", 500, RecoveryId, owned); }
          handle.Dispose(); Fail("RECOVERY_REQUIRED", 500, null);
        }
        handle.Dispose();
      }
    }
    byte[] RecoveryHeader() {
      Dictionary<string, object> meta = new Dictionary<string, object>();
      meta["v"] = PROTOCOL_VERSION; meta["operationId"] = OperationId; meta["recoveryBinding"] = RecoveryBinding;
      meta["rootIdentity"] = RootIdentity; meta["parentIdentity"] = ParentIdentity; meta["targetIdentity"] = TargetIdentity;
      meta["currentVersion"] = CurrentVersion; meta["originalSize"] = OriginalSize; meta["originalHash"] = OriginalHash;
      meta["relativePath"] = RelativePath; meta["newSize"] = NewBytes.Length;
      return Utf8.GetBytes(new JavaScriptSerializer().Serialize(meta) + "\n");
    }
    // Returns false when the owned record could not be removed; the caller then reports the
    // retained record instead of silently claiming a clean run.
    bool DeleteRecovery() {
      if (RecoveryPath == null || RecoveryIdentity == null) return true;
      SafeFileHandle handle = CreateFile(RecoveryPath, DELETE, 0, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (handle.IsInvalid) { handle.Dispose(); return false; }
      Info info;
      bool ok = GetFileInformationByHandle(handle, out info) && Identity(info) == RecoveryIdentity && (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
      if (ok) { FileDispositionInfo disposition = new FileDispositionInfo(); disposition.delete = 1; ok = SetFileInformationByHandle(handle, 4, ref disposition, 1); }
      handle.Dispose();
      return ok;
    }
    class QuotaReservation : IDisposable {
      SafeWaitHandle mutex;
      QuotaReservation(SafeWaitHandle handle) { mutex = handle; }
      public static QuotaReservation Acquire(string dataDir) {
        string name = "Local\\ProjectWriterQuota-" + Sha256Hex(Utf8.GetBytes(NormDrive(dataDir)));
        SafeWaitHandle handle = CreateMutex(IntPtr.Zero, false, name);
        if (handle.IsInvalid) { handle.Dispose(); Fail("RECOVERY_REQUIRED", 503, null); }
        uint wait = WaitForSingleObject(handle, 5000);
        if (wait != 0 && wait != 0x80) { handle.Dispose(); Fail("RECOVERY_REQUIRED", 503, null); }
        return new QuotaReservation(handle);
      }
      public void Dispose() {
        if (mutex == null) return;
        try { ReleaseMutex(mutex); } catch { }
        mutex.Dispose(); mutex = null;
      }
    }
  }

  static SafeFileHandle PinRootChain(string root) {
    string volume = root.Substring(0, 3);
    SafeFileHandle last = PinDirectory(volume);
    string current = volume;
    string rest = root.Substring(3);
    if (rest.Length > 0) {
      string[] parts = rest.Split('\\');
      for (int i = 0; i < parts.Length; i++) { current = Path.Combine(current, parts[i]); last = PinDirectory(current); }
    }
    return last;
  }
  static SafeFileHandle PinRelative(string root, string relative) {
    if (relative.Length == 0) return null;
    string current = root; SafeFileHandle last = null;
    string[] parts = relative.Split('/');
    for (int i = 0; i < parts.Length; i++) { current = Path.Combine(current, parts[i]); last = PinDirectory(current); }
    return last;
  }
  static SafeFileHandle PinDirectory(string path) {
    SafeFileHandle handle = CreateFile(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); Fail("PROJECT_UNAVAILABLE", 403, null); }
    Info info;
    if (!GetFileInformationByHandle(handle, out info) || (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || !SamePath(path, FinalPath(handle))) {
      handle.Dispose(); Fail("PROJECT_UNAVAILABLE", 403, null);
    }
    pinned.Add(handle); return handle;
  }
  static SafeFileHandle OpenDirVerify(string path, uint access, uint share, out Info info) {
    SafeFileHandle handle = CreateFile(path, access, share, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); Fail("PROJECT_UNAVAILABLE", 403, null); }
    if (!GetFileInformationByHandle(handle, out info) || (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || !SamePath(path, FinalPath(handle))) {
      handle.Dispose(); Fail("PROJECT_UNAVAILABLE", 403, null);
    }
    return handle;
  }
  static SafeFileHandle OpenFile(string path, uint access, uint share, out Info info) {
    SafeFileHandle handle = CreateFile(path, access, share, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) {
      handle.Dispose(); int code = Marshal.GetLastWin32Error();
      if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) Fail("NOT_FOUND", 404, null);
      if (code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION) Fail("LOCKED", 423, null);
      Fail("FILE_RESTRICTED", 403, null);
    }
    if (!GetFileInformationByHandle(handle, out info) || (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || info.links != 1 || !SamePath(path, FinalPath(handle))) {
      handle.Dispose(); Fail("FILE_RESTRICTED", 403, null);
    }
    return handle;
  }
  static StageData OpenStage(string path, string dataDir, long expectedSize, string expectedHash, long max) {
    if (!Inside(dataDir, path)) Fail("STAGE_INVALID", 403, null);
    Info info;
    SafeFileHandle handle = CreateFile(path, GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); Fail("STAGE_INVALID", 403, null); }
    if (!GetFileInformationByHandle(handle, out info) || (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || info.links != 1 || !SamePath(path, FinalPath(handle)) || !Inside(dataDir, path)) {
      handle.Dispose(); Fail("STAGE_INVALID", 403, null);
    }
    long size = Size(info);
    if (size > max) { handle.Dispose(); Fail("TOO_LARGE", 413, null); }
    if (size != expectedSize) { handle.Dispose(); Fail("STAGE_CHANGED", 409, null); }
    byte[] bytes = ReadAll(handle, size, max);
    string hash = Sha256(bytes);
    if (!String.Equals(hash, expectedHash, StringComparison.Ordinal)) { handle.Dispose(); Fail("STAGE_CHANGED", 409, null); }
    StageData stage = new StageData(); stage.Handle = handle; stage.Info = info; stage.Bytes = bytes; stage.Hash = hash; stage.Size = size;
    return stage;
  }

  static void EnsureAbsent(string path) {
    try { File.GetAttributes(path); Fail("ALREADY_EXISTS", 409, null); }
    catch (WriterException) { throw; }
    catch (FileNotFoundException) { }
    catch (DirectoryNotFoundException) { }
    catch (IOException) { if (File.Exists(path) || Directory.Exists(path)) Fail("ALREADY_EXISTS", 409, null); Fail("PROJECT_UNAVAILABLE", 403, null); }
    catch (UnauthorizedAccessException) { if (File.Exists(path) || Directory.Exists(path)) Fail("ALREADY_EXISTS", 409, null); Fail("PROJECT_UNAVAILABLE", 403, null); }
  }
  static bool PathnameOurs(string path, string identity, string canonical) {
    SafeFileHandle handle = CreateFile(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) {
      int code = Marshal.GetLastWin32Error(); handle.Dispose();
      if (code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION) return true;
      return false;
    }
    Info info;
    bool ok = GetFileInformationByHandle(handle, out info) && (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 && Identity(info) == identity && SamePath(path, FinalPath(handle)) && SamePath(path, canonical);
    handle.Dispose(); return ok;
  }
  // Handle-scoped delete-on-close. The BOOL is checked: a failure means the object we own is still
  // at its name, which callers must report instead of assuming a clean no-leftover state.
  static bool MarkDelete(SafeFileHandle handle) {
    if (Fault("mark-delete")) return false;
    FileDispositionInfo disposition = new FileDispositionInfo(); disposition.delete = 1;
    return SetFileInformationByHandle(handle, 4, ref disposition, 1);
  }
  static void CleanupDirectory(string path, string identity) {
    Info info; SafeFileHandle handle;
    try { handle = OpenDirVerify(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, out info); }
    catch { return; }
    bool match = Identity(info) == identity; handle.Dispose();
    if (match) RemoveDirectory(path);
  }

  static byte[] ReadAll(SafeFileHandle handle, long size, long max) {
    if (size < 0 || size > max) Fail("TOO_LARGE", 413, null);
    int total = (int)size; byte[] result = new byte[total];
    long position; if (!SetFilePointerEx(handle, 0, out position, 0)) Fail("IO_ERROR", 500, null);
    int offset = 0; byte[] chunk = new byte[Math.Min(65536, Math.Max(1, total))];
    while (offset < total) {
      uint want = (uint)Math.Min(chunk.Length, total - offset); uint read;
      if (!ReadFile(handle, chunk, want, out read, IntPtr.Zero) || read == 0) Fail("IO_ERROR", 500, null);
      Buffer.BlockCopy(chunk, 0, result, offset, (int)read); offset += (int)read;
    }
    return result;
  }
  static void WriteAll(SafeFileHandle handle, byte[] bytes, string fault) {
    long position; if (!SetFilePointerEx(handle, 0, out position, 0)) throw new IOException();
    int offset = 0;
    while (offset < bytes.Length) {
      if (fault != null && offset == 0 && Fault(fault + ":first")) throw new IOException();
      int length = Math.Min(65536, bytes.Length - offset); byte[] chunk = new byte[length];
      Buffer.BlockCopy(bytes, offset, chunk, 0, length); uint written;
      if (!WriteFile(handle, chunk, (uint)length, out written, IntPtr.Zero) || written != (uint)length) throw new IOException();
      offset += length;
      if (fault != null && offset < bytes.Length && Fault(fault + ":partial")) throw new IOException();
    }
    if (!SetEndOfFile(handle)) throw new IOException();
    if (fault != null && Fault(fault + ":flush")) throw new IOException();
    if (!FlushFileBuffers(handle)) throw new IOException();
  }

  static Info InfoOf(SafeFileHandle handle) { Info info; if (!GetFileInformationByHandle(handle, out info)) Fail("IO_ERROR", 500, null); return info; }
  static long Size(Info info) { return (long)(((ulong)info.highSize << 32) | info.lowSize); }
  static string Identity(Info info) { return info.volume.ToString("x") + "-" + info.highIndex.ToString("x") + "-" + info.lowIndex.ToString("x"); }
  static string Version(string identity, string hash) { return "v1." + identity + "." + hash; }
  static string FinalPath(SafeFileHandle handle) {
    StringBuilder buffer = new StringBuilder(32768); uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
    if (length == 0 || length >= buffer.Capacity) Fail("PROJECT_UNAVAILABLE", 403, null);
    string value = buffer.ToString();
    if (value.StartsWith("\\\\?\\UNC\\")) Fail("PROJECT_UNAVAILABLE", 403, null);
    if (value.StartsWith("\\\\?\\")) value = value.Substring(4);
    if (value.StartsWith("\\\\")) Fail("PROJECT_UNAVAILABLE", 403, null);
    return value;
  }
  static string NormDrive(string value) { if (value.Length >= 2 && value[1] == ':') return Char.ToUpperInvariant(value[0]) + value.Substring(1); return value; }
  static string Key(string value) { return NormDrive(Path.GetFullPath(value).TrimEnd('\\')); }
  static bool SamePath(string a, string b) { return String.Equals(Key(a), Key(b), StringComparison.Ordinal); }
  static bool Inside(string root, string target) { string a = Key(root), b = Key(target); return b == a || b.StartsWith(a + "\\", StringComparison.Ordinal); }

  static void ValidateRoot(string root) {
    if (root == null || root.Length < 3 || root.Length > 4096 || HasControl(root) || root.IndexOf('/') >= 0 || root.StartsWith("\\\\")) Fail("INVALID_OPERATION", 400, null);
    if (!IsAsciiLetter(root[0]) || root[1] != ':' || root[2] != '\\') Fail("INVALID_OPERATION", 400, null);
    if (root.Length == 3) Fail("PROJECT_UNAVAILABLE", 403, null);
    if (root.EndsWith("\\")) Fail("INVALID_OPERATION", 400, null);
    string[] parts = root.Substring(3).Split('\\');
    for (int i = 0; i < parts.Length; i++) ValidateLeaf(parts[i]);
    string full = Path.GetFullPath(root);
    if (!String.Equals(NormDrive(full.TrimEnd('\\')), NormDrive(root.TrimEnd('\\')), StringComparison.Ordinal)) Fail("INVALID_OPERATION", 400, null);
  }
  static void ValidateRelative(string relative, bool allowEmpty) {
    if (relative == null || relative.Length > 4096 || HasControl(relative) || relative.IndexOf('\\') >= 0 || relative.IndexOf(':') >= 0) Fail("INVALID_OPERATION", 400, null);
    if (relative.Length == 0) { if (allowEmpty) return; Fail("INVALID_OPERATION", 400, null); }
    if (relative.StartsWith("/") || relative.EndsWith("/")) Fail("INVALID_OPERATION", 400, null);
    string[] parts = relative.Split('/');
    for (int i = 0; i < parts.Length; i++) ValidateLeaf(parts[i]);
  }
  static void ValidateLeaf(string leaf) {
    if (leaf == null || leaf.Length == 0 || leaf.Length > 255 || leaf == "." || leaf == "..") Fail("INVALID_OPERATION", 400, null);
    for (int i = 0; i < leaf.Length; i++) { char c = leaf[i]; if (c < 0x20 || c == 0x7f || "<>:\"/\\|?*".IndexOf(c) >= 0) Fail("INVALID_OPERATION", 400, null); }
    if (leaf.EndsWith(".") || leaf.EndsWith(" ")) Fail("INVALID_OPERATION", 400, null);
    try { if (!String.Equals(leaf.Normalize(NormalizationForm.FormC), leaf, StringComparison.Ordinal)) Fail("INVALID_OPERATION", 400, null); }
    catch { Fail("INVALID_OPERATION", 400, null); }
    string baseName = leaf; int dot = leaf.IndexOf('.'); if (dot >= 0) baseName = leaf.Substring(0, dot);
    if (Reserved(baseName.TrimEnd(' ', '.'))) Fail("INVALID_OPERATION", 400, null);
  }
  static bool Reserved(string value) {
    string lower = value.ToLowerInvariant();
    string[] names = new string[] { "con", "prn", "aux", "nul", "clock$", "conin$", "conout$", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "com¹", "com²", "com³", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "lpt¹", "lpt²", "lpt³" };
    for (int i = 0; i < names.Length; i++) if (lower == names[i]) return true;
    return false;
  }
  static string ValidateDataDir(string dataDir) {
    if (dataDir == null || dataDir.Length < 4 || dataDir.Length > 4096 || HasControl(dataDir) || dataDir.StartsWith("\\\\") || dataDir.IndexOf('/') >= 0) Fail("INVALID_OPERATION", 400, null);
    string full = Path.GetFullPath(dataDir);
    if (!String.Equals(NormDrive(full.TrimEnd('\\')), NormDrive(dataDir.TrimEnd('\\')), StringComparison.Ordinal)) Fail("INVALID_OPERATION", 400, null);
    string volume = Path.GetPathRoot(full);
    if (String.Equals(full.TrimEnd('\\'), volume.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) Fail("INVALID_OPERATION", 400, null);
    if (!Directory.Exists(full)) Fail("INVALID_OPERATION", 400, null);
    Info info; SafeFileHandle handle = OpenDirVerify(full, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, out info); handle.Dispose();
    return full;
  }

  static bool IsAsciiLetter(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
  static bool HasControl(string value) { for (int i = 0; i < value.Length; i++) if (value[i] < 0x20 || value[i] == 0x7f) return true; return false; }
  static bool IsHex(string value, int length, bool exact) {
    if (value == null || value.Length < 1 || value.Length > length || (exact && value.Length != length)) return false;
    for (int i = 0; i < value.Length; i++) { char c = value[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; }
    return true;
  }
  static bool IsVersion(string value) {
    if (value == null || !value.StartsWith("v1.", StringComparison.Ordinal)) return false;
    int dot = value.IndexOf('.', 3); if (dot < 0) return false;
    string identity = value.Substring(3, dot - 3), hash = value.Substring(dot + 1);
    if (!IsHex(hash, 64, true)) return false;
    string[] parts = identity.Split('-'); if (parts.Length != 3) return false;
    for (int i = 0; i < parts.Length; i++) if (!IsHex(parts[i], 8, false)) return false;
    return true;
  }
  static string Sha256(byte[] bytes) { using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(bytes)); }
  static string Sha256Hex(byte[] bytes) { return Sha256(bytes); }
  static string Hex(byte[] bytes) { StringBuilder builder = new StringBuilder(bytes.Length * 2); for (int i = 0; i < bytes.Length; i++) builder.Append(bytes[i].ToString("x2")); return builder.ToString(); }

  static Dictionary<string, object> ParseObject(string json) {
    try {
      object value = new JavaScriptSerializer().DeserializeObject(json);
      Dictionary<string, object> dictionary = value as Dictionary<string, object>;
      if (dictionary == null) Fail("PROTOCOL_ERROR", 400, null);
      return dictionary;
    } catch (WriterException) { throw; }
    catch { Fail("PROTOCOL_ERROR", 400, null); return null; }
  }
  static void RequireOnly(Dictionary<string, object> dictionary, string[] allowed) {
    foreach (string key in dictionary.Keys) { bool found = false; for (int i = 0; i < allowed.Length; i++) if (allowed[i] == key) { found = true; break; } if (!found) Fail("PROTOCOL_ERROR", 400, null); }
  }
  static string GetString(Dictionary<string, object> dictionary, string key) {
    object value; if (!dictionary.TryGetValue(key, out value) || !(value is string)) Fail("PROTOCOL_ERROR", 400, null); return (string)value;
  }
  static int GetInt(Dictionary<string, object> dictionary, string key) {
    object value; if (!dictionary.TryGetValue(key, out value)) Fail("PROTOCOL_ERROR", 400, null);
    if (value is int) return (int)value;
    if (value is long && (long)value >= int.MinValue && (long)value <= int.MaxValue) return (int)(long)value;
    Fail("PROTOCOL_ERROR", 400, null); return 0;
  }
  static long GetLong(Dictionary<string, object> dictionary, string key) {
    object value; if (!dictionary.TryGetValue(key, out value)) Fail("PROTOCOL_ERROR", 400, null);
    if (value is int) return (int)value;
    if (value is long) return (long)value;
    if (value is decimal) { decimal d = (decimal)value; if (d == Decimal.Truncate(d) && d >= 0 && d <= Int64.MaxValue) return (long)d; }
    Fail("PROTOCOL_ERROR", 400, null); return 0;
  }

  static string ReadFrame(int max) {
    Stream input = Console.OpenStandardInput();
    byte[] header = ReadExact(input, 4);
    if (header == null) return null;
    int length = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
    if (length <= 0 || length > max) Fail("PROTOCOL_ERROR", 400, null);
    byte[] body = ReadExact(input, length);
    if (body == null) Fail("PROTOCOL_ERROR", 400, null);
    try { return Utf8.GetString(body); } catch { Fail("PROTOCOL_ERROR", 400, null); return null; }
  }
  static byte[] ReadExact(Stream input, int length) {
    byte[] buffer = new byte[length]; int offset = 0;
    while (offset < length) { int read = input.Read(buffer, offset, length - offset); if (read <= 0) { if (offset == 0) return null; Fail("PROTOCOL_ERROR", 400, null); } offset += read; }
    return buffer;
  }
  static void Send(Dictionary<string, object> message) {
    JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = (int)MAX_RESULT;
    byte[] body = Utf8.GetBytes(serializer.Serialize(message));
    if (body.Length <= 0 || body.Length > MAX_RESULT) throw new WriterException("PROTOCOL_ERROR", 500, null);
    byte[] header = new byte[4]; header[0] = (byte)body.Length; header[1] = (byte)(body.Length >> 8); header[2] = (byte)(body.Length >> 16); header[3] = (byte)(body.Length >> 24);
    Stream output = Console.OpenStandardOutput(); output.Write(header, 0, 4); output.Write(body, 0, body.Length); output.Flush();
  }
  static Dictionary<string, object> AbortAck(PreparedState state) {
    Dictionary<string, object> m = new Dictionary<string, object>();
    m["v"] = PROTOCOL_VERSION; m["t"] = "aborted"; m["operationId"] = state.OperationId; return m;
  }
  static void SendError(WriterException error) {
    try {
      Dictionary<string, object> m = new Dictionary<string, object>();
      m["v"] = PROTOCOL_VERSION; m["t"] = "error"; m["code"] = error.Code; m["status"] = error.Status;
      if (error.RecoveryId != null) m["recoveryId"] = error.RecoveryId;
      if (error.CleanupIdentity != null) m["cleanupIdentity"] = error.CleanupIdentity;
      Send(m);
    } catch { }
  }
  static void Fail(string code, int status, string recoveryId) { throw new WriterException(code, status, recoveryId, null); }
  static void Fail(string code, int status, string recoveryId, string cleanupIdentity) { throw new WriterException(code, status, recoveryId, cleanupIdentity); }
}

class WriterException : Exception {
  public string Code; public int Status; public string RecoveryId; public string CleanupIdentity;
  public WriterException(string code, int status, string recoveryId) : this(code, status, recoveryId, null) { }
  public WriterException(string code, int status, string recoveryId, string cleanupIdentity) : base(code) {
    Code = code; Status = status; RecoveryId = recoveryId; CleanupIdentity = cleanupIdentity;
  }
}
