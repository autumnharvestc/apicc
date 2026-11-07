using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// Test-only debugger: stop the real helper at the first caller instruction
// after the real native CreateProcessW returns, kill it, observe its suspended
// tool, and then explicitly collect every process created by this fixture.
public static class StartupWindowProbe {
    [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
        public int cb; public string reserved, desktop, title;
        public int x,y,width,height,countX,countY,fill,flags; public short show,reservedSize;
        public IntPtr reservedPointer,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr minimum,maximum; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT value,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING value,uint size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr handle,byte[] buffer,uint count,out uint written,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool WaitForDebugEvent(IntPtr debugEvent,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ContinueDebugEvent(uint pid,uint tid,uint status);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DebugSetProcessKillOnExit(bool kill);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DebugActiveProcessStop(uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenThread(uint access,bool inherit,uint id);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetThreadContext(IntPtr thread,IntPtr context);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetThreadContext(IntPtr thread,IntPtr context);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder name,ref uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] buffer,UIntPtr size,out UIntPtr read);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteProcessMemory(IntPtr process,IntPtr address,byte[] buffer,UIntPtr size,out UIntPtr written);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushInstructionCache(IntPtr process,IntPtr address,UIntPtr size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll",CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module,string name);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static readonly Stopwatch watch = Stopwatch.StartNew();
    static readonly List<object> events = new List<object>();
    static void Event(string kind,object detail) { if(events.Count < 200) events.Add(new { ms=watch.ElapsedMilliseconds,kind=kind,detail=detail }); }
    static void Check(bool value,string stage) { if(!value) throw new Exception(stage+":"+Marshal.GetLastWin32Error()); }
    static void Close(IntPtr handle) { if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle); }
    static string Quote(string text) { return "\""+text.Replace("\"","\\\"")+"\""; }
    static string ImageName(IntPtr process) {
        StringBuilder text=new StringBuilder(4096);uint length=4096;
        Check(QueryFullProcessImageNameW(process,0,text,ref length),"process-image");return Path.GetFileName(text.ToString());
    }
    static IntPtr RemotePointer(IntPtr process,IntPtr address) {
        byte[] value=new byte[IntPtr.Size];UIntPtr count;
        Check(ReadProcessMemory(process,address,value,new UIntPtr((uint)value.Length),out count) && count.ToUInt64()==(uint)value.Length,"read-remote-pointer");
        return new IntPtr(BitConverter.ToInt64(value,0));
    }
    static byte Patch(IntPtr process,IntPtr address,byte value) {
        byte[] original=new byte[1];UIntPtr read,written;
        Check(ReadProcessMemory(process,address,original,new UIntPtr(1),out read) && read.ToUInt64()==1,"read-breakpoint-byte");
        Check(WriteProcessMemory(process,address,new byte[]{value},new UIntPtr(1),out written) && written.ToUInt64()==1,"write-breakpoint-byte");
        Check(FlushInstructionCache(process,address,new UIntPtr(1)),"flush-breakpoint");return original[0];
    }
    static IntPtr OpenContext(uint tid,out IntPtr allocated,out IntPtr context) {
        Check(IntPtr.Size==8,"x64-fixture-required");
        IntPtr thread=OpenThread(0x58,false,tid);Check(thread!=IntPtr.Zero,"open-helper-thread");
        allocated=Marshal.AllocHGlobal(1248);context=new IntPtr((allocated.ToInt64()+15)&~15L);
        try {
            for(int i=0;i<1232;i++)Marshal.WriteByte(context,i,0);
            Marshal.WriteInt32(context,48,0x00100003);
            Check(GetThreadContext(thread,context),"helper-thread-context");return thread;
        } catch { Marshal.FreeHGlobal(allocated);Close(thread);throw; }
    }

    public static int Main(string[] args) {
        string helper=args[0],node=args[1],directory=args[2],report=args[3];
        PI helperProcess = new PI(); IntPtr toolProcess=IntPtr.Zero; uint toolPid=0;
        IntPtr fixtureJob=IntPtr.Zero;bool fixtureJobEmpty=false;
        IntPtr read=IntPtr.Zero,write=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero;
        IntPtr buffer=Marshal.AllocHGlobal(176); bool injected=false,helperExited=false,toolStillActive=false,rootExecuted=false,cleanup=false;
        string failure=null;
        try {
            // Keep an outer fixture Job alive during the observation so it does
            // not mask a helper ownership gap; terminate it on every exit path.
            fixtureJob=CreateJobObjectW(IntPtr.Zero,null);Check(fixtureJob!=IntPtr.Zero,"fixture-job");
            EXTENDED_LIMIT limits=new EXTENDED_LIMIT();limits.basic.flags=0x2000;
            Check(SetInformationJobObject(fixtureJob,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))),"fixture-job-limit");
            SA sa=new SA { length=Marshal.SizeOf(typeof(SA)),inherit=1 };
            Check(CreatePipe(out read,out write,ref sa,0),"input-pipe");
            Check(CreatePipe(out outRead,out outWrite,ref sa,0),"output-pipe");
            Check(SetHandleInformation(write,1,0) && SetHandleInformation(outRead,1,0),"parent-handles");
            for(int kind=-10;kind>=-12;kind--) { IntPtr handle=GetStdHandle(kind);if(handle!=IntPtr.Zero && handle!=new IntPtr(-1))Check(SetHandleInformation(handle,1,0),"fixture-standard-handles"); }
            SI si=new SI { cb=Marshal.SizeOf(typeof(SI)),flags=0x100,input=read,output=outWrite,error=outWrite };
            Check(CreateProcessW(helper,new StringBuilder(Quote(helper)),IntPtr.Zero,IntPtr.Zero,true,0x08000001,IntPtr.Zero,directory,ref si,out helperProcess),"create-debug-helper");
            // A debug-created helper is stopped before its entry point, so no
            // application child can start before this fixture ownership step.
            Check(AssignProcessToJobObject(fixtureJob,helperProcess.process),"own-debug-helper");
            Check(DebugSetProcessKillOnExit(false),"debug-kill-policy");
            Close(read);read=IntPtr.Zero;Close(outWrite);outWrite=IntPtr.Zero;
            string marker=Path.Combine(directory,"root-ran.txt");
            string script="require('node:fs').writeFileSync("+json.Serialize(marker)+",'unexpected-resume');setInterval(()=>{},1000);";
            var descriptor=new { toolPath=node,args=new string[] {"-e",script},cwd=directory,env=new Dictionary<string,string>{{"SystemRoot",Environment.GetEnvironmentVariable("SystemRoot")}},maxOutputBytes=1024 };
            byte[] input=Encoding.UTF8.GetBytes(json.Serialize(descriptor)+"\n");uint written;
            Check(WriteFile(write,input,(uint)input.Length,out written,IntPtr.Zero) && written==input.Length,"descriptor-write");
            IntPtr create=GetProcAddress(GetModuleHandleW("kernel32.dll"),"CreateProcessW");
            Check(create!=IntPtr.Zero,"create-address");bool patched=false,awaitingReturn=false;byte createByte=0;
            IntPtr returnAddress=IntPtr.Zero,information=IntPtr.Zero;
            int u=IntPtr.Size==8?16:12;
            while(watch.ElapsedMilliseconds<15000 && !helperExited) {
                if(!WaitForDebugEvent(buffer,250)) continue;
                uint code=(uint)Marshal.ReadInt32(buffer,0),pid=(uint)Marshal.ReadInt32(buffer,4),tid=(uint)Marshal.ReadInt32(buffer,8);
                uint disposition=0x00010002;
                if(code==3) {
                    Close(Marshal.ReadIntPtr(buffer,u));
                    if(pid!=helperProcess.pid) {
                        Event("debug-child-created",new { pid=pid,name=ImageName(Marshal.ReadIntPtr(buffer,u+IntPtr.Size)) });
                    }
                } else if(code==6) {
                    Close(Marshal.ReadIntPtr(buffer,u));
                } else if(code==1) {
                    uint exception=(uint)Marshal.ReadInt32(buffer,u);
                    IntPtr address=Marshal.ReadIntPtr(buffer,u+(IntPtr.Size==8?16:12));
                    if(exception==0x80000003 && pid==helperProcess.pid && !patched) {
                        createByte=Patch(helperProcess.process,create,0xcc);Check(createByte==Marshal.ReadByte(create),"same-native-api-entry");patched=true;
                        Event("breakpoint-installed",new { pointerBits=IntPtr.Size*8 });
                    } else if(exception==0x80000003 && pid==helperProcess.pid && patched && !awaitingReturn && address==create) {
                        IntPtr allocation,context;IntPtr thread=OpenContext(tid,out allocation,out context);
                        try {
                            IntPtr stack=Marshal.ReadIntPtr(context,152);
                            returnAddress=RemotePointer(helperProcess.process,stack);
                            information=RemotePointer(helperProcess.process,new IntPtr(stack.ToInt64()+80));
                            Patch(helperProcess.process,returnAddress,0xcc);Patch(helperProcess.process,create,createByte);
                            Marshal.WriteIntPtr(context,248,create);Check(SetThreadContext(thread,context),"resume-create-entry");
                        } finally { Marshal.FreeHGlobal(allocation);Close(thread); }
                        awaitingReturn=true;Event("create-entry",new { helperPid=pid });
                    } else if(exception==0x80000003 && pid==helperProcess.pid && awaitingReturn && address==returnAddress) {
                        IntPtr allocation,context;IntPtr thread=OpenContext(tid,out allocation,out context);
                        try { Check(Marshal.ReadInt64(context,120)!=0,"create-process-succeeded"); }
                        finally { Marshal.FreeHGlobal(allocation);Close(thread); }
                        IntPtr remoteProcess=RemotePointer(helperProcess.process,information);
                        Check(DuplicateHandle(helperProcess.process,remoteProcess,new IntPtr(-1),out toolProcess,0,false,2),"duplicate-created-tool");toolPid=GetProcessId(toolProcess);
                        Check(toolPid!=0 && ImageName(toolProcess)==Path.GetFileName(node),"actual-node-at-create-return");
                        Event("at-create-return",new { helperPid=pid,toolPid=toolPid,toolName=ImageName(toolProcess) });
                        Check(TerminateProcess(helperProcess.process,77),"kill-helper-at-create-return");injected=true;
                    } else disposition=0x80010001;
                } else if(code==5 && pid==helperProcess.pid) {
                    helperExited=true;Event("helper-exit",new { code=Marshal.ReadInt32(buffer,u) });
                }
                Check(ContinueDebugEvent(pid,tid,disposition),"continue-debug-event");
            }
            Check(injected && helperExited,"injection-reached");
            Check(WaitForSingleObject(helperProcess.process,5000)==0,"helper-os-exit");
            uint waited=WaitForSingleObject(toolProcess,2000);Check(waited==0 || waited==258,"tool-wait-state");
            uint toolCode;Check(GetExitCodeProcess(toolProcess,out toolCode),"tool-exit-state");
            toolStillActive=toolCode==259 && waited==258;
            rootExecuted=File.Exists(marker);
            Event("after-helper-exit",new { toolExitCode=toolCode,toolStillActive=toolStillActive,rootExecuted=rootExecuted });
        } catch(Exception error) { failure=error.Message; }
        finally {
            if(fixtureJob!=IntPtr.Zero) TerminateJobObject(fixtureJob,78);
            if(helperProcess.process!=IntPtr.Zero) TerminateProcess(helperProcess.process,78);
            if(toolPid!=0) DebugActiveProcessStop(toolPid);
            if(toolProcess!=IntPtr.Zero) TerminateProcess(toolProcess,78);
            Stopwatch drain=Stopwatch.StartNew();
            while(drain.ElapsedMilliseconds<3000) {
                if(!WaitForDebugEvent(buffer,100)) {
                    if(toolProcess==IntPtr.Zero || WaitForSingleObject(toolProcess,0)==0) break;
                    continue;
                }
                uint code=(uint)Marshal.ReadInt32(buffer,0),pid=(uint)Marshal.ReadInt32(buffer,4),tid=(uint)Marshal.ReadInt32(buffer,8);
                ContinueDebugEvent(pid,tid,0x00010002);
            }
            cleanup=toolProcess==IntPtr.Zero || WaitForSingleObject(toolProcess,1000)==0;
            if(fixtureJob!=IntPtr.Zero) {
                Stopwatch collecting=Stopwatch.StartNew();
                do { ACCOUNTING value;if(!QueryInformationJobObject(fixtureJob,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))break;if(value.active==0){fixtureJobEmpty=true;break;}System.Threading.Thread.Sleep(10); } while(collecting.ElapsedMilliseconds<2000);
            }
            if(helperProcess.pid!=0) DebugActiveProcessStop(helperProcess.pid);
            if(toolPid!=0) DebugActiveProcessStop(toolPid);
            Close(helperProcess.thread);Close(helperProcess.process);Close(read);Close(write);Close(outRead);Close(outWrite);
            Close(toolProcess);
            Close(fixtureJob);
            Marshal.FreeHGlobal(buffer);
            File.WriteAllText(report,json.Serialize(new { injectedAtCreateReturn=injected,helperExited=helperExited,toolStillActiveAfterHelperExit=toolStillActive,rootExecuted=rootExecuted,fixtureToolCollected=cleanup,fixtureJobEmpty=fixtureJobEmpty,failure=failure,events=events })+"\n");
        }
        return failure==null && injected && helperExited && !rootExecuted && cleanup && fixtureJobEmpty ? 0:1;
    }
}
