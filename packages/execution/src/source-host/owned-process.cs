using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Built with stock Windows .NET at application build time. No runtime compiler.
public static class ApiccOwnedProcess
{
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved; public string desktop; public string title;
        public int x, y, width, height, countX, countY, fill, flags; public short show, reservedSize;
        public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum;
        public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly object gate = new object();
    static volatile bool stop;
    static string failure;
    static int outputBytes;
    static int limit;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };

    static void Frame(object value) { Console.Out.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static void ReadOutput(IntPtr handle, MemoryStream output) {
        try {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false)) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                    lock (gate) {
                        if (outputBytes + count > limit) { failure = "SYNC_PROCESS_OUTPUT_LIMIT"; stop = true; }
                        else { outputBytes += count; output.Write(buffer, 0, count); }
                    }
                }
            }
        } catch { lock (gate) { if (failure == null) failure = "SYNC_PROCESS_UNCOLLECTED"; stop = true; } }
    }
    static bool Active(IntPtr job, out uint count) {
        ACCOUNTING value; bool ok = QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero);
        count = ok ? value.active : 1; return ok;
    }
    static int Supervise() {
        // Read a bounded descriptor before creating any child or private Job.
        StringBuilder line = new StringBuilder(); int c;
        while ((c = Console.In.Read()) >= 0 && c != '\n') { if (line.Length >= 65536) { Frame(new { kind = "collected", activeProcesses = 0, exitCode = -1, errorCode = "SYNC_PROCESS_INPUT_LIMIT", stdout = "", stderr = "" }); return 0; } line.Append((char)c); }
        Dictionary<string, object> input = json.Deserialize<Dictionary<string, object>>(line.ToString());
        string tool = (string)input["toolPath"]; string cwd = (string)input["cwd"]; limit = Convert.ToInt32(input["maxOutputBytes"]);
        ArrayList args = input["args"] as ArrayList;
        if (args == null) args = new ArrayList((object[])input["args"]);
        StringBuilder command = new StringBuilder(Quote(tool)); foreach (object arg in args) command.Append(' ').Append(Quote((string)arg));
        Dictionary<string, object> env = (Dictionary<string, object>)input["env"];
        List<string> keys = new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder block = new StringBuilder(); foreach (string key in keys) block.Append(key).Append('=').Append((string)env[key]).Append('\0'); block.Append('\0');
        if (keys.Count == 0) block.Append('\0');
        IntPtr environment = Marshal.StringToHGlobalUni(block.ToString());
        IntPtr job = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero, stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, stdinNull = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION(); bool assigned = false; bool launched = false;
        try {
            job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Exception();
            EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway permission.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw new Exception();
            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = 1 };
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref sa, 0) || !CreatePipe(out stderrRead, out stderrWrite, ref sa, 0)) throw new Exception();
            if (!SetHandleInformation(stdoutRead, 1, 0) || !SetHandleInformation(stderrRead, 1, 0)) throw new Exception();
            // The child must never inherit the supervisor's control/proof pipes.
            for (int kind = -10; kind >= -12; kind--) { IntPtr handle = GetStdHandle(kind); if (handle != IntPtr.Zero && handle != new IntPtr(-1)) SetHandleInformation(handle, 1, 0); }
            stdinNull = CreateFileW("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero); if (stdinNull == new IntPtr(-1)) throw new Exception();
            STARTUPINFO startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), flags = 0x100, input = stdinNull, output = stdoutWrite, error = stderrWrite };
            // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW
            if (!CreateProcessW(tool, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000404, environment, cwd, ref startup, out child)) throw new Exception();
            launched = true;
            if (!AssignProcessToJobObject(job, child.process)) throw new Exception(); assigned = true;
            Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref stdinNull);
            MemoryStream stdout = new MemoryStream(), stderr = new MemoryStream();
            IntPtr outHandle = stdoutRead, errHandle = stderrRead; stdoutRead = IntPtr.Zero; stderrRead = IntPtr.Zero;
            Thread outThread = new Thread(() => ReadOutput(outHandle, stdout)); outThread.IsBackground = true; outThread.Start();
            Thread errThread = new Thread(() => ReadOutput(errHandle, stderr)); errThread.IsBackground = true; errThread.Start();
            Thread control = new Thread(() => { try { while (Console.In.ReadLine() != null) { stop = true; } stop = true; } catch { stop = true; } }); control.IsBackground = true; control.Start();
            if (ResumeThread(child.thread) == 0xffffffff) throw new Exception();
            Frame(new { kind = "started", pid = child.processId });
            while (!stop && WaitForSingleObject(child.process, 20) == 258) { }
            uint exitCode; if (!GetExitCodeProcess(child.process, out exitCode)) throw new Exception();
            if (!TerminateJobObject(job, 1)) throw new Exception();
            Stopwatch collecting = Stopwatch.StartNew(); uint active;
            while (true) {
                if (!Active(job, out active)) throw new Exception(); if (active == 0) break;
                if (collecting.ElapsedMilliseconds > 5000) throw new Exception(); Thread.Sleep(10);
            }
            if (!outThread.Join(2000) || !errThread.Join(2000)) throw new Exception();
            if (failure == "SYNC_PROCESS_UNCOLLECTED") throw new Exception();
            Frame(new { kind = "collected", activeProcesses = 0, exitCode = unchecked((int)exitCode), errorCode = failure, stdout = Convert.ToBase64String(stdout.ToArray()), stderr = Convert.ToBase64String(stderr.ToArray()) });
            return 0;
        } catch {
            if (!assigned) {
                bool collected = !launched;
                if (launched) { TerminateProcess(child.process, 1); collected = WaitForSingleObject(child.process, 5000) == 0; }
                if (collected) { Frame(new { kind = "collected", activeProcesses = 0, exitCode = -1, errorCode = "SYNC_PROCESS_START_FAILED", stdout = "", stderr = "" }); return 0; }
            }
            Frame(new { kind = "uncollected" }); return 1;
        } finally {
            Close(ref child.thread); Close(ref child.process); Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite); Close(ref stdinNull); Close(ref job); Marshal.FreeHGlobal(environment);
        }
    }
    public static int Main(string[] args) {
        string mode = Environment.GetEnvironmentVariable("APICC_SOURCE_BRIDGE_MODE");
        try {
            Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
            if (mode == "askpass") {
                string path = Environment.GetEnvironmentVariable("APICC_SOURCE_ASKPASS_FILE");
                if (String.IsNullOrEmpty(path) || !File.Exists(path) || new FileInfo(path).Length > 65536) return 1;
                byte[] bytes = File.ReadAllBytes(path);
                using (Stream output = Console.OpenStandardOutput()) { output.Write(bytes, 0, bytes.Length); output.Flush(); }
                return 0;
            }
            if (mode == "ssh") {
                string tool = Environment.GetEnvironmentVariable("APICC_SOURCE_SSH_TOOL"), configuration = Environment.GetEnvironmentVariable("APICC_SOURCE_SSH_CONFIG");
                if (String.IsNullOrEmpty(tool) || String.IsNullOrEmpty(configuration)) return 255;
                StringBuilder command = new StringBuilder(Quote(tool)).Append(" -F ").Append(Quote(configuration)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
                // The child atomically inherits Git's already assigned non-breakaway Job.
                Environment.SetEnvironmentVariable("APICC_SOURCE_BRIDGE_MODE", "askpass");
                STARTUPINFO startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), flags = 0x100, input = GetStdHandle(-10), output = GetStdHandle(-11), error = GetStdHandle(-12) };
                foreach (IntPtr handle in new IntPtr[] { startup.input, startup.output, startup.error }) if (!SetHandleInformation(handle, 1, 1)) return 255;
                PROCESS_INFORMATION ssh;
                if (!CreateProcessW(tool, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero, null, ref startup, out ssh)) return 255;
                try { if (WaitForSingleObject(ssh.process, 0xffffffff) != 0) return 255; uint code; return GetExitCodeProcess(ssh.process, out code) ? unchecked((int)code) : 255; }
                finally { Close(ref ssh.thread); Close(ref ssh.process); }
            }
            if (!String.IsNullOrEmpty(mode)) return 1;
            return Supervise();
        } catch { if (!String.IsNullOrEmpty(mode)) return mode == "ssh" ? 255 : 1; Frame(new { kind = "uncollected" }); return 1; }
    }
}
