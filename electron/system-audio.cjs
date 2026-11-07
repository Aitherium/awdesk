"use strict";

/**
 * system-audio.cjs -- Windows speaker + microphone control for the Desk.
 *
 * Owner, 2026-11-02: "hot keys and better way to control audio / system speaker
 * and mic settings in awdesk". Windows has no supported command-line for "set the
 * default output device" or "read the current mute flag", so this module speaks
 * Core Audio directly:
 *
 *   IMMDeviceEnumerator  enumerate active render/capture endpoints, the default one
 *   IPropertyStore       PKEY_Device_FriendlyName -> the name Windows shows
 *   IAudioEndpointVolume master volume (scalar 0..1) + mute, read and written
 *   IPolicyConfig        SetDefaultEndpoint -- the only way to move the Windows default
 *
 * The COM declarations are one resident PowerShell: PowerShell compiles the C#
 * with Add-Type once (~1 s) and then answers a line protocol on stdin/stdout
 * (the warm-GDI-grabber pattern in snip-window.cjs). One warm helper serves every
 * press; a dead helper is restarted by the next request, never by a timer.
 *
 * Protocol -- one request per line, one JSON reply per line, replies in order:
 *   ping                    -> {"ok":true}
 *   state                   -> {"ok":true,"render":EP,"capture":EP}
 *   list                    -> {"ok":true,"render":[D...],"capture":[D...]}
 *   set-volume <f> <pct>    pct is "0".."100" or a signed delta "+5"/"-5"
 *   set-mute <f> <0|1>
 *   toggle-mute <f>
 *   set-default <f> <deviceId>
 *   EP = {"id","name","volume":0..100,"muted":bool}   D = {"id","name","default":bool}
 *   f  = "render" (speakers) | "capture" (microphone)
 *
 * Nothing here shows UI or knows about hotkeys; audio-control.cjs owns that.
 * The pure helpers below are exported for node --test without PowerShell.
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** One request's ceiling. The FIRST request also pays Add-Type's compile. */
const REQUEST_TIMEOUT_MS = 9000;
/** Volume step for the hotkeys and the flyout's +/- buttons. */
const VOLUME_STEP = 5;

const CSHARP = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AitherAudio
{
    const int CLSCTX_ALL = 23;
    const int STGM_READ = 0;
    const int DEVICE_STATE_ACTIVE = 1;

    enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        int GetCount(out uint count);
        int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint count);
        int GetAt(uint index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        int Commit();
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out uint count);
        int SetMasterVolumeLevel(float level, ref Guid ctx);
        int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        int GetMasterVolumeLevel(out float level);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float level, ref Guid ctx);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid ctx);
        int GetChannelVolumeLevel(uint channel, out float level);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute(int mute, ref Guid ctx);
        int GetMute(out int mute);
        int GetVolumeStepInfo(out uint step, out uint stepCount);
        int VolumeStepUp(ref Guid ctx);
        int VolumeStepDown(ref Guid ctx);
        int QueryHardwareSupport(out uint mask);
        int GetVolumeRange(out float min, out float max, out float inc);
    }

    // Undocumented since Vista and still present on Windows 11: it is what the
    // Sound control panel itself calls when a device is set as default.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string name, out IntPtr ppFormat);
        int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, int bDefault, out IntPtr ppFormat);
        int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name);
        int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr endpointFormat, IntPtr mixFormat);
        int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, int bDefault, out long defPeriod, out long minPeriod);
        int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, ref long period);
        int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, out int mode);
        int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, ref int mode);
        int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, int bFxStore, ref PROPERTYKEY key, out PROPVARIANT pv);
        int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, int bFxStore, ref PROPERTYKEY key, ref PROPVARIANT pv);
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string name, ERole role);
        int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string name, int bVisible);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    class CPolicyConfigClient { }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PROPERTYKEY { public Guid fmtid; public int pid; }

    // 24 bytes on x64 (8-byte header + the 16-byte union); the size matters,
    // because PropVariantClear writes the whole thing.
    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT { public short vt; public short r1; public short r2; public short r3; public IntPtr p1; public IntPtr p2; }

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PROPVARIANT pvar);

    static readonly Guid PKEY_FRIENDLY_NAME_FMTID = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    const int PKEY_FRIENDLY_NAME_PID = 14;
    const short VT_LPWSTR = 31;

    static void Check(int hr, string what) { if (hr != 0) throw new COMException(what, hr); }

    static IMMDeviceEnumerator Enumerator() { return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject(); }

    static IMMDevice DefaultDevice(EDataFlow flow)
    {
        IMMDevice dev;
        int hr = Enumerator().GetDefaultAudioEndpoint(flow, ERole.eMultimedia, out dev);
        if (hr != 0) return null;
        return dev;
    }

    static string DeviceId(IMMDevice dev)
    {
        string id;
        Check(dev.GetId(out id), "GetId");
        return id;
    }

    static string DeviceName(IMMDevice dev)
    {
        try
        {
            IPropertyStore store;
            if (dev.OpenPropertyStore(STGM_READ, out store) != 0) return null;
            PROPERTYKEY key = new PROPERTYKEY();
            key.fmtid = PKEY_FRIENDLY_NAME_FMTID;
            key.pid = PKEY_FRIENDLY_NAME_PID;
            PROPVARIANT pv = new PROPVARIANT();
            if (store.GetValue(ref key, out pv) != 0) return null;
            try
            {
                if (pv.vt == VT_LPWSTR && pv.p1 != IntPtr.Zero) return Marshal.PtrToStringUni(pv.p1);
            }
            finally { PropVariantClear(ref pv); }
        }
        catch { }
        return null;
    }

    static IAudioEndpointVolume Volume(IMMDevice dev)
    {
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        Check(dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "Activate(IAudioEndpointVolume)");
        return (IAudioEndpointVolume)o;
    }

    static EDataFlow Flow(string flow)
    {
        string f = (flow == null ? "" : flow.ToLowerInvariant());
        if (f == "capture" || f == "input" || f == "mic") return EDataFlow.eCapture;
        return EDataFlow.eRender;
    }

    static string EndpointJson(EDataFlow flow)
    {
        IMMDevice dev;
        try { dev = DefaultDevice(flow); } catch { dev = null; }
        if (dev == null) return "null";
        string id = DeviceId(dev);
        string name = DeviceName(dev);
        // One endpoint that does not expose IAudioEndpointVolume (some HDMI/DP
        // sinks and virtual capture devices) must not fail the whole state: fall
        // back to 0 % / unmuted for THIS endpoint, so the other flow, the device
        // list and the tray labels keep working.
        int volume = 0;
        int muted = 0;
        try
        {
            IAudioEndpointVolume vol = Volume(dev);
            try { float scalar; if (vol.GetMasterVolumeLevelScalar(out scalar) == 0) volume = Convert.ToInt32(Math.Round(scalar * 100.0)); } catch { }
            try { int m; if (vol.GetMute(out m) == 0) muted = m; } catch { }
        }
        catch { }
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"id\":").Append(Q(id));
        sb.Append(",\"name\":").Append(Q(name == null ? "Unknown device" : name));
        sb.Append(",\"volume\":").Append(volume);
        sb.Append(",\"muted\":").Append(muted != 0 ? "true" : "false");
        sb.Append("}");
        return sb.ToString();
    }

    static string ListEndpointJson(EDataFlow flow)
    {
        IMMDeviceCollection coll;
        Check(Enumerator().EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out coll), "EnumAudioEndpoints");
        uint n;
        Check(coll.GetCount(out n), "GetCount");
        string defId = null;
        try { IMMDevice def = DefaultDevice(flow); if (def != null) defId = DeviceId(def); } catch { }
        StringBuilder sb = new StringBuilder("[");
        for (uint i = 0; i < n; i++)
        {
            IMMDevice d;
            Check(coll.Item(i, out d), "Item");
            string id = DeviceId(d);
            string name = DeviceName(d);
            if (i > 0) sb.Append(",");
            sb.Append("{\"id\":").Append(Q(id));
            sb.Append(",\"name\":").Append(Q(name == null ? "Unknown device" : name));
            sb.Append(",\"default\":").Append(id == defId ? "true" : "false");
            sb.Append("}");
        }
        sb.Append("]");
        return sb.ToString();
    }

    static void SetVolume(EDataFlow flow, string spec)
    {
        IMMDevice dev = DefaultDevice(flow);
        if (dev == null) throw new InvalidOperationException("no default " + (flow == EDataFlow.eCapture ? "microphone" : "speaker") + " is selected");
        IAudioEndpointVolume vol = Volume(dev);
        float current;
        Check(vol.GetMasterVolumeLevelScalar(out current), "read volume");
        double target;
        if (spec != null && (spec.StartsWith("+") || spec.StartsWith("-")))
        {
            double delta = double.Parse(spec, System.Globalization.CultureInfo.InvariantCulture);
            target = current * 100.0 + delta;
        }
        else
        {
            target = double.Parse(spec, System.Globalization.CultureInfo.InvariantCulture);
        }
        target = Math.Max(0.0, Math.Min(100.0, Math.Round(target)));
        Guid ctx = Guid.Empty;
        Check(vol.SetMasterVolumeLevelScalar((float)(target / 100.0), ref ctx), "SetMasterVolumeLevelScalar");
    }

    static void SetMuted(EDataFlow flow, bool muted)
    {
        IMMDevice dev = DefaultDevice(flow);
        if (dev == null) throw new InvalidOperationException("no default device is selected");
        Guid ctx = Guid.Empty;
        Check(Volume(dev).SetMute(muted ? 1 : 0, ref ctx), "SetMute");
    }

    static void ToggleMute(EDataFlow flow)
    {
        IMMDevice dev = DefaultDevice(flow);
        if (dev == null) throw new InvalidOperationException("no default device is selected");
        IAudioEndpointVolume vol = Volume(dev);
        int muted;
        Check(vol.GetMute(out muted), "GetMute");
        Guid ctx = Guid.Empty;
        Check(vol.SetMute(muted == 0 ? 1 : 0, ref ctx), "SetMute");
    }

    static void SetDefault(EDataFlow flow, string id)
    {
        if (String.IsNullOrEmpty(id)) throw new ArgumentException("no device id");
        IPolicyConfig policy = (IPolicyConfig)new CPolicyConfigClient();
        ERole[] roles = new ERole[] { ERole.eConsole, ERole.eMultimedia, ERole.eCommunications };
        foreach (ERole role in roles) Check(policy.SetDefaultEndpoint(id, role), "SetDefaultEndpoint");
    }

    static string StateJson()
    {
        return "{\"ok\":true,\"render\":" + EndpointJson(EDataFlow.eRender) + ",\"capture\":" + EndpointJson(EDataFlow.eCapture) + "}";
    }

    public static string Handle(string line)
    {
        string[] p = (line == null ? "" : line.Trim()).Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        string cmd = p.Length > 0 ? p[0].ToLowerInvariant() : "";
        try
        {
            switch (cmd)
            {
                case "ping": return "{\"ok\":true}";
                case "state": return StateJson();
                case "list": return "{\"ok\":true,\"render\":" + ListEndpointJson(EDataFlow.eRender) + ",\"capture\":" + ListEndpointJson(EDataFlow.eCapture) + "}";
                case "set-volume": SetVolume(Flow(p.Length > 1 ? p[1] : "render"), p.Length > 2 ? p[2] : "0"); return StateJson();
                case "set-mute":
                {
                    string v = p.Length > 2 ? p[2].ToLowerInvariant() : "1";
                    SetMuted(Flow(p.Length > 1 ? p[1] : "render"), v == "1" || v == "true");
                    return StateJson();
                }
                case "toggle-mute": ToggleMute(Flow(p.Length > 1 ? p[1] : "render")); return StateJson();
                case "set-default": SetDefault(Flow(p.Length > 1 ? p[1] : "render"), p.Length > 2 ? p[2] : null); return StateJson();
                default: return "{\"ok\":false,\"error\":\"unknown command: " + Q(cmd).Trim('"') + "\"}";
            }
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":" + Q(ex.Message) + "}";
        }
    }

    static string Q(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append("\"");
        return sb.ToString();
    }
}
`;

/**
 * The resident PowerShell. `@' ... '@` is a literal here-string, so the C# is
 * handed over byte for byte -- no $ expansion. The terminator must start at
 * column 0; that is why this is assembled line by line.
 */
function buildHelperScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    CSHARP.replace(/^\n/, "").replace(/\n$/, ""),
    "'@",
    "[Console]::Out.WriteLine('ready')",
    "[Console]::Out.Flush()",
    "while ($null -ne ($line = [Console]::In.ReadLine())) {",
    "  if ($line.Trim().Length -eq 0) { continue }",
    "  try { $out = [AitherAudio]::Handle($line) }",
    "  catch { $out = '{\"ok\":false,\"error\":\"helper failed\"}' }",
    "  [Console]::Out.WriteLine($out)",
    "  [Console]::Out.Flush()",
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- pure helpers

/** Clamp any number to an integer percent 0..100; NaN/undefined become 0. */
function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Every endpoint shape this module emits, normalized (never trusts the wire). */
function normalizeEndpoint(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: String(raw.id || ""),
    name: String(raw.name || "Unknown device"),
    volume: clampPercent(raw.volume),
    muted: Boolean(raw.muted),
  };
}

/** `state` / any mutation reply -> {ok, render, capture, error?}. */
function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || raw.ok === false) {
    return { ok: false, render: null, capture: null, error: String((raw && raw.error) || "the Windows audio helper did not answer") };
  }
  return { ok: true, render: normalizeEndpoint(raw.render), capture: normalizeEndpoint(raw.capture) };
}

/** `list` reply -> {ok, render:[{id,name,default}], capture:[...]}. */
function normalizeList(raw) {
  const devices = (rows) => (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .map((row) => ({ id: String(row.id || ""), name: String(row.name || "Unknown device"), default: Boolean(row.default) }));
  if (!raw || typeof raw !== "object" || raw.ok === false) {
    return { ok: false, render: [], capture: [], error: String((raw && raw.error) || "the Windows audio helper did not answer") };
  }
  return { ok: true, render: devices(raw.render), capture: devices(raw.capture) };
}

/** One reply line -> the parsed object; a malformed line is a visible failure. */
function parseReply(line) {
  const text = String(line == null ? "" : line).trim();
  if (!text) return { ok: false, error: "the Windows audio helper sent an empty reply" };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "the Windows audio helper sent a non-object reply" };
    }
    return value;
  } catch {
    return { ok: false, error: `unreadable reply from the Windows audio helper: ${text.slice(0, 120)}` };
  }
}

/** "render" | "capture" for anything a caller might pass; speakers by default. */
function flowFor(kind) {
  const value = String(kind || "").toLowerCase();
  return value === "capture" || value === "input" || value === "mic" ? "capture" : "render";
}

/**
 * The on-screen display's model (audio-osd.html renders it). Kept pure so the
 * wording -- which is the only thing a 1.2 s toast has room for -- is testable.
 */
function osdModel({ flow = "render", endpoint = null, error = "" } = {}) {
  const render = flowFor(flow) === "render";
  const subject = render ? "Speakers" : "Microphone";
  if (error || !endpoint) {
    return {
      kind: render ? "speaker" : "mic", icon: render ? "volume-off" : "mic-off",
      title: subject, value: "Unavailable", percent: 0, muted: false,
      note: String(error || "No default device"),
    };
  }
  return {
    kind: render ? "speaker" : "mic",
    icon: endpoint.muted ? (render ? "volume-off" : "mic-off") : (render ? "volume" : "mic"),
    title: subject,
    value: endpoint.muted ? "Muted" : `${endpoint.volume}%`,
    percent: endpoint.volume,
    muted: Boolean(endpoint.muted),
    note: endpoint.name,
  };
}

// --------------------------------------------------------------- the resident helper

let helper = null; // { child, ready:Promise<boolean>, waiters:[], chain:Promise }
let scriptSerial = 0;

/**
 * A NEW file per helper spawn. The old shared per-pid name let a dead helper's
 * exit handler delete the script the replacement was launched with; a unique
 * name means each dead() only ever unlinks its own file.
 */
function scriptFile() {
  scriptSerial += 1;
  return path.join(os.tmpdir(), `aither-system-audio-${process.pid}-${scriptSerial}.ps1`);
}

/** Spawn the warm helper (idempotent). Returns null when Windows is not available. */
function startHelper() {
  if (process.platform !== "win32") return null;
  if (helper) return helper;
  const file = scriptFile();
  try { fs.writeFileSync(file, buildHelperScript(), "utf8"); } catch { return null; }
  const child = spawn("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const g = { child, waiters: [], chain: Promise.resolve(), ready: null };
  let buf = "";
  let onReady;
  g.ready = new Promise((resolve) => { onReady = resolve; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === "ready") onReady(true);
      else if (g.waiters.length) g.waiters.shift()(line);
    }
  });
  const dead = (reason) => {
    onReady(false);
    for (const w of g.waiters.splice(0)) w(`__dead__ ${reason}`);
    if (helper === g) helper = null;
    try { fs.unlinkSync(file); } catch { /* temp file already gone */ }
  };
  child.on("error", (error) => dead(String((error && error.message) || error)));
  child.on("exit", (code) => dead(`helper exited (${code})`));
  helper = g;
  return g;
}

/** Stop the helper; the next request starts a fresh one. */
function stopHelper() {
  const g = helper;
  helper = null;
  if (g) {
    try { g.child.kill(); } catch { /* already gone */ }
  }
}

/** Never let a stale request's timer kill the replacement helper. */
function stopHelperIfCurrent(g) {
  if (helper === g) stopHelper();
}

/**
 * `g.ready` bounded. Add-Type can hang (antivirus scan, a wedged powershell.exe,
 * an ExecutionPolicy prompt); without this the first hotkey hung forever and
 * every later request queued behind it.
 */
function readyWithin(g, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    Promise.resolve(g.ready).then(
      (ready) => finish(ready === true),
      () => finish(false),
    );
  });
}

/** Warm the helper ahead of the first hotkey press (main calls this after boot). */
function warm({ timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "system audio control is Windows-only" });
  const g = startHelper();
  if (!g) return Promise.resolve({ ok: false, error: "the Windows audio helper could not be written to temp" });
  return readyWithin(g, timeoutMs).then((ready) => {
    if (ready === "timeout") {
      stopHelperIfCurrent(g);
      return { ok: false, error: "the Windows audio helper did not start in time" };
    }
    return { ok: ready, error: ready ? "" : "the Windows audio helper could not start" };
  });
}

/**
 * One request. Requests are serialized (the protocol is positional) and a
 * timeout tears the helper down rather than leaving a reply to land on the
 * wrong caller.
 */
function request(line, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "system audio control is Windows-only" });
  const g = startHelper();
  if (!g) return Promise.resolve({ ok: false, error: "the Windows audio helper could not be written to temp" });
  const run = async () => {
    const ready = await readyWithin(g, timeoutMs);
    if (ready === "timeout") {
      stopHelperIfCurrent(g);
      return { ok: false, error: "the Windows audio helper did not start in time" };
    }
    if (!ready) return { ok: false, error: "the Windows audio helper could not start (PowerShell or Add-Type was refused)" };
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let waiter = null;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const detach = () => {
        const index = g.waiters.indexOf(waiter);
        if (index >= 0) g.waiters.splice(index, 1);
      };
      waiter = (answer) => {
        clearTimeout(timer);
        if (String(answer).startsWith("__dead__")) {
          finish({ ok: false, error: String(answer).replace("__dead__ ", "") });
          return;
        }
        finish(parseReply(answer));
      };
      timer = setTimeout(() => {
        detach();
        finish({ ok: false, error: `the Windows audio helper did not answer within ${Math.round(timeoutMs / 1000)} s` });
        stopHelperIfCurrent(g);
      }, timeoutMs);
      g.waiters.push(waiter);
      try {
        g.child.stdin.write(`${line}\n`);
      } catch {
        clearTimeout(timer);
        detach();
        finish({ ok: false, error: "the Windows audio helper is gone" });
        stopHelperIfCurrent(g);
      }
    });
  };
  const result = g.chain.then(run, run);
  g.chain = result.then(() => null, () => null);
  return result;
}

// ------------------------------------------------------------------ public API

async function getState() {
  return normalizeState(await request("state"));
}

async function listDevices() {
  return normalizeList(await request("list"));
}

/** Set the master volume for `flow`; `percent` is absolute 0..100. */
async function setVolume(flow, percent) {
  return normalizeState(await request(`set-volume ${flowFor(flow)} ${clampPercent(percent)}`));
}

/** Step the master volume by `delta` percent (negative = quieter). */
async function adjustVolume(flow, delta, step = VOLUME_STEP) {
  const signed = Number(delta) >= 0 ? `+${Math.abs(Number(delta) || step)}` : `-${Math.abs(Number(delta) || step)}`;
  return normalizeState(await request(`set-volume ${flowFor(flow)} ${signed}`));
}

async function setMuted(flow, muted) {
  return normalizeState(await request(`set-mute ${flowFor(flow)} ${muted ? 1 : 0}`));
}

/** Flip mute in Windows (read + write in one round trip, so two presses cannot race). */
async function toggleMute(flow) {
  return normalizeState(await request(`toggle-mute ${flowFor(flow)}`));
}

async function setDefaultDevice(flow, deviceId) {
  return normalizeState(await request(`set-default ${flowFor(flow)} ${String(deviceId || "")}`));
}

module.exports = {
  VOLUME_STEP, REQUEST_TIMEOUT_MS,
  // pure
  clampPercent, normalizeEndpoint, normalizeState, normalizeList, parseReply, flowFor, osdModel,
  buildHelperScript, scriptFile,
  // helper lifecycle + commands
  warm, stopHelper, getState, listDevices, setVolume, adjustVolume, setMuted, toggleMute, setDefaultDevice,
  // test seam
  __setHelperForTest(next) { helper = next; },
  __requestForTest(line, options) { return request(line, options); },
};
