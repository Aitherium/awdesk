// DeskMouseHook.cs -- the desk's low-level right-click hook (owner 2026-11-23).
//
// It exists for ONE gesture: a plain right-click on the EMPTY desktop opens the
// fairy's ring. It is deliberately tiny and fail-soft:
//
//   * it acts ONLY when the press lands on the shell's desktop window (Progman /
//     WorkerW) or the desktop's icon view (SysListView32) AND no icon is under the
//     cursor (LVM_HITTEST reports no item);
//   * every other mouse event is passed straight through untouched; Shift+right-click
//     on the desktop is passed through too, so Windows' own menu still opens;
//   * a qualifying press is swallowed (down and up) so the native menu never appears,
//     and one JSON line {type:"right",x,y} is queued for the desk;
//   * nothing is recorded or stored; the per-click work is one hit test, timed into
//     the `stats` reply;
//   * any failure (hook refused, no desktop) prints one error line and exits; the
//     desktop is unaffected because the process only ever passes events through.
//
// Protocol: stdout is one JSON line per event ("ready", "right", "stats", "error");
// stdin accepts "stats" and "quit". Built with the .NET Framework csc.exe, so the
// desk needs no Visual Studio toolchain.

using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class DeskMouseHook
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int VK_SHIFT = 0x10;
    private const int GA_ROOT = 2;
    private const uint LVM_HITTEST = 0x1000 + 18; // LVM_FIRST + 18

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct LVHITTESTINFO { public POINT pt; public uint flags; public int iItem; public int iSubItem; public int iGroup; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, ref LVHITTESTINFO lParam);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static readonly ConcurrentQueue<string> OutQueue = new ConcurrentQueue<string>();
    private static readonly object StatsLock = new object();
    private static long _rights, _qualifying, _calls;
    private static double _totalMs, _maxMs;
    private static bool _swallowUp;
    private static LowLevelMouseProc _proc; // kept alive for the hook's lifetime

    private static void Emit(string line) { OutQueue.Enqueue(line); }

    /// <summary>Drain the queue synchronously (on the way out, so nothing is lost).</summary>
    private static void FlushQueue()
    {
        string line;
        var stdout = Console.Out;
        while (OutQueue.TryDequeue(out line))
        {
            stdout.WriteLine(line);
        }
        stdout.Flush();
    }

    private static void WriterLoop()
    {
        var stdout = Console.Out;
        while (true)
        {
            string line;
            if (OutQueue.TryDequeue(out line))
            {
                stdout.WriteLine(line);
                stdout.Flush();
            }
            else
            {
                Thread.Sleep(5);
            }
        }
    }

    private static string ClassOf(IntPtr h)
    {
        if (h == IntPtr.Zero) return "";
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    private static bool ListViewHasIconAt(IntPtr listView, POINT screenPoint)
    {
        if (listView == IntPtr.Zero) return false;
        var client = screenPoint;
        if (!ScreenToClient(listView, ref client)) return false;
        var hit = new LVHITTESTINFO();
        hit.pt = client;
        SendMessage(listView, LVM_HITTEST, IntPtr.Zero, ref hit);
        return hit.iItem >= 0;
    }

    /// <summary>Is this point the empty desktop (no icon under it)?</summary>
    private static bool IsEmptyDesktop(POINT p)
    {
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return false;
        string cls = ClassOf(h);
        IntPtr root = GetAncestor(h, GA_ROOT);
        string rootCls = ClassOf(root);

        // The shell's desktop window: always empty background (icons live in the
        // list view, which WindowFromPoint would have returned instead).
        if (cls == "Progman" || cls == "WorkerW" || rootCls == "Progman" || rootCls == "WorkerW")
            return true;

        if (cls == "SysListView32") return !ListViewHasIconAt(h, p);

        if (cls == "SHELLDLL_DefView")
        {
            IntPtr listView = FindWindowEx(h, IntPtr.Zero, "SysListView32", null);
            return !ListViewHasIconAt(listView, p);
        }
        return false;
    }

    private static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_RBUTTONUP && _swallowUp)
            {
                _swallowUp = false;
                return (IntPtr)1; // the qualifying press is consumed
            }
            if (msg == WM_RBUTTONDOWN)
            {
                var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                var watch = Stopwatch.StartNew();
                bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
                bool ours = !shift && IsEmptyDesktop(info.pt);
                watch.Stop();
                double ms = watch.Elapsed.TotalMilliseconds;
                lock (StatsLock)
                {
                    _rights++;
                    _calls++;
                    _totalMs += ms;
                    if (ms > _maxMs) _maxMs = ms;
                    if (ours) _qualifying++;
                }
                if (ours)
                {
                    _swallowUp = true;
                    Emit("{\"type\":\"right\",\"x\":" + info.pt.X + ",\"y\":" + info.pt.Y + "}");
                    return (IntPtr)1;
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static string StatsJson()
    {
        double avg, max; long rights, qualifying, calls;
        lock (StatsLock)
        {
            avg = _calls > 0 ? _totalMs / _calls : 0;
            max = _maxMs;
            rights = _rights;
            qualifying = _qualifying;
            calls = _calls;
        }
        double cpuMs = Process.GetCurrentProcess().TotalProcessorTime.TotalMilliseconds;
        return "{\"type\":\"stats\",\"rights\":" + rights + ",\"qualifying\":" + qualifying
            + ",\"calls\":" + calls + ",\"avgMs\":" + avg.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)
            + ",\"maxMs\":" + max.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)
            + ",\"cpuMs\":" + cpuMs.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + "}";
    }

    private static void StdinLoop(uint threadId)
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string what = line.Trim().ToLowerInvariant();
                if (what == "stats") Emit(StatsJson());
                else if (what.StartsWith("probe "))
                {
                    string[] parts = what.Split(' ');
                    int px, py;
                    if (parts.Length >= 3 && int.TryParse(parts[1], out px) && int.TryParse(parts[2], out py))
                    {
                        var pt = new POINT(); pt.X = px; pt.Y = py;
                        IntPtr h = WindowFromPoint(pt);
                        string cls = ClassOf(h);
                        Emit("{\"type\":\"probe\",\"x\":" + px + ",\"y\":" + py
                            + ",\"class\":\"" + cls.Replace("\"", "'") + "\",\"empty\":" + (IsEmptyDesktop(pt) ? "true" : "false") + "}");
                    }
                    else Emit("{\"type\":\"error\",\"error\":\"probe needs x y\"}");
                }
                else if (what == "quit")
                {
                    PostThreadMessage(threadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
                    return;
                }
            }
        }
        catch { }
    }

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    private static int Main()
    {
        try
        {
            var writer = new Thread(WriterLoop);
            writer.IsBackground = true;
            writer.Start();
            _proc = HookProc;
            IntPtr hook = SetWindowsHookEx(WH_MOUSE_LL, _proc, IntPtr.Zero, 0);
            if (hook == IntPtr.Zero)
            {
                Emit("{\"type\":\"error\",\"error\":\"the mouse hook was refused\"}");
                FlushQueue();
                return 2;
            }
            // WM_QUIT must go to the thread that owns the message loop: capture the
            // MAIN thread id here, never inside the reader thread.
            uint mainThread = GetCurrentThreadId();
            var reader = new Thread(delegate() { StdinLoop(mainThread); });
            reader.IsBackground = true;
            reader.Start();            Emit("{\"type\":\"ready\"}");
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            UnhookWindowsHookEx(hook);
            FlushQueue();
            return 0;
        }
        catch (Exception error)
        {
            Emit("{\"type\":\"error\",\"error\":\"" + error.Message.Replace("\\", "/").Replace("\"", "'") + "\"}");
            FlushQueue();
            return 1;
        }
    }
}
