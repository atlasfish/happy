param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$source = @'
using System;
using System.Runtime.InteropServices;

public static class HappyRestartManager {
    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string ApplicationName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint handle, int flags, string key);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint handle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, RM_UNIQUE_PROCESS[] apps, uint serviceCount, string[] services);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] processes, ref uint reasons);

    public static int[] Find(string path) {
        uint handle;
        if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0) return new int[0];
        try {
            RmRegisterResources(handle, 1, new[] { path }, 0, null, 0, null);
            uint needed = 0, count = 0, reasons = 0;
            int result = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (result != 234 || needed == 0) return new int[0];
            var processes = new RM_PROCESS_INFO[needed];
            count = needed;
            if (RmGetList(handle, out needed, ref count, processes, ref reasons) != 0) return new int[0];
            var ids = new int[count];
            for (int i = 0; i < count; i++) ids[i] = processes[i].Process.ProcessId;
            return ids;
        } finally {
            RmEndSession(handle);
        }
    }
}
'@

Add-Type -TypeDefinition $source
@([HappyRestartManager]::Find($Path)) | ConvertTo-Json -Compress
