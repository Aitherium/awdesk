// AitherShellMenu.dll -- Windows 11 File Explorer context-menu handler.
//
// The Windows 11 "modern" context menu only shows commands that come from a
// package with identity (a sparse MSIX for this unpackaged Electron app). The
// package manifest registers this DLL as a COM surrogate server and wires its
// CLSID to the shell item types. File Explorer loads the DLL on its UI thread,
// so every menu-construction method below is cheap; the actual work (starting
// Desk.exe) happens in Invoke().
//
// Contract: each verb launches the desk with `--run=<id>` and appends one
// `--arg=<quoted path>` per selected shell item (`spirit.go` appends
// {"kind":"file","target":"<path>","requester":"shell"} instead).
// electron/main.cjs parses those in its second-instance and cold-start paths.
//
// The desk is not always a packaged Desk.exe: it can run unpackaged as
// `"<electron.exe>" "<app dir>"`. main.cjs therefore records the exact launch
// command on every start under HKCU\Software\Aither\Desk\LaunchCommand, and
// this DLL resolves it at click time. When the value is missing it falls back
// to Desk.exe in the sparse package's ExternalLocation (a real install, or the
// per-user Desk.exe stub, see src/DeskStub.cpp).
//
// References:
//   https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer
//   https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-iexplorercommand

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shobjidl_core.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <cstdio>
#include <new>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "user32.lib")

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

constexpr wchar_t kProductName[] = L"Aither";
constexpr UINT kIconResourceId = 101;

// Must match AppxManifest.xml: com:Class/@Id and desktop5:Verb/@Clsid.
// {0B88D9C5-6159-41B2-88F1-2DD360C7D2AE}
const CLSID CLSID_AitherShellMenu = {
    0x0B88D9C5, 0x6159, 0x41B2, {0x88, 0xF1, 0x2D, 0xD3, 0x60, 0xC7, 0xD2, 0xAE}};

struct Verb {
  const wchar_t* id;       // Desk --run=<id>
  const wchar_t* title;    // menu label
  const wchar_t* tooltip;  // hover text
};

// Keep this table in the same order the owner asked for. The ids are the desk
// command contract; see native/shell-menu/README.md for which ids already
// exist in electron/command-registry.cjs.
const Verb kVerbs[] = {
    {L"snip.region", L"Snip a region", L"Capture part of the screen with Aither"},
    {L"record.region", L"Record a region", L"Record part of the screen with Aither"},
    {L"record.region.audio", L"Record a region with sound",
     L"Record a region with system and microphone audio"},
    {L"ink.toggle", L"Draw on screen", L"Turn on Aither's on-screen drawing layer"},
    {L"note.new", L"New note", L"Start a new Aither note"},
    {L"board.new", L"New whiteboard", L"Open a new Aither whiteboard"},
    {L"orb.ask-screen", L"Ask Aither", L"Ask Aither about what is on screen"},
    {L"spirit.go", L"Send to Aither", L"Send the selected items to Aither's spirit"},
    {L"search.universal", L"Find a file", L"Search this PC with Aither"},
};

std::wstring ModulePath() {
  wchar_t buffer[MAX_PATH * 4] = {};
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(&ModulePath), &module)) {
    return {};
  }
  const DWORD length = GetModuleFileNameW(module, buffer, ARRAYSIZE(buffer));
  if (length == 0 || length >= ARRAYSIZE(buffer)) return {};
  return std::wstring(buffer, length);
}

std::wstring ModuleDir() {
  const std::wstring path = ModulePath();
  const size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

bool FileExists(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

// The exact command line main.cjs records on every desk start: `"<exe>"` for a
// packaged install, `"<exe>" "<app dir>"` for an unpackaged Electron run.
// Empty when the desk has never started or the value is blank.
std::wstring ReadLaunchCommand() {
  constexpr wchar_t kKey[] = L"Software\\Aither\\Desk";
  constexpr wchar_t kValue[] = L"LaunchCommand";
  constexpr DWORD kFlags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;

  DWORD type = 0;
  DWORD bytes = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, kKey, kValue, kFlags, &type, nullptr,
                   &bytes) != ERROR_SUCCESS ||
      bytes < sizeof(wchar_t)) {
    return {};
  }

  std::vector<wchar_t> buffer(bytes / sizeof(wchar_t));
  DWORD read = bytes;
  if (RegGetValueW(HKEY_CURRENT_USER, kKey, kValue, kFlags, &type,
                   buffer.data(), &read) != ERROR_SUCCESS) {
    return {};
  }

  std::wstring value(buffer.data(), read / sizeof(wchar_t));
  while (!value.empty() && value.back() == L'\0') value.pop_back();
  if (value.find_first_not_of(L" \t\r\n") == std::wstring::npos) return {};
  return value;
}

// Find the installed Desk.exe without a registry probe. The installer copies
// this DLL to <ExternalLocation>\shell-menu\, so the normal case is the
// ExternalLocation root's own Desk.exe (the real app, or the per-user stub).
// The environment fallbacks cover the default NSIS locations.
std::wstring FindDeskExe() {
  const std::wstring dir = ModuleDir();
  const size_t slash = dir.find_last_of(L"\\/");
  const std::wstring install = slash == std::wstring::npos ? dir : dir.substr(0, slash);

  std::vector<std::wstring> candidates;
  if (!install.empty()) candidates.push_back(install + L"\\Desk.exe");

  wchar_t buffer[MAX_PATH * 4] = {};
  if (GetEnvironmentVariableW(L"ProgramFiles", buffer, ARRAYSIZE(buffer)) > 0) {
    candidates.push_back(std::wstring(buffer) + L"\\Aither\\Desk.exe");
  }
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", buffer, ARRAYSIZE(buffer)) > 0) {
    candidates.push_back(std::wstring(buffer) + L"\\Programs\\Aither\\Desk.exe");
  }

  for (const std::wstring& candidate : candidates) {
    if (FileExists(candidate)) return candidate;
  }
  return {};
}

// CommandLineToArgvW-compatible quoting, so paths with spaces, quotes or a
// trailing backslash survive the hop from Explorer to Desk's argv.
std::wstring QuoteArg(const std::wstring& argument) {
  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted += L'"';
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted += character;
  }
  quoted.append(backslashes * 2, L'\\');
  quoted += L'"';
  return quoted;
}

// JSON string escaping for the spirit's {"kind":"file", ...} argument.
std::wstring JsonEscape(const std::wstring& value) {
  std::wstring escaped;
  for (const wchar_t character : value) {
    switch (character) {
      case L'"': escaped += L"\\\""; break;
      case L'\\': escaped += L"\\\\"; break;
      case L'\b': escaped += L"\\b"; break;
      case L'\f': escaped += L"\\f"; break;
      case L'\n': escaped += L"\\n"; break;
      case L'\r': escaped += L"\\r"; break;
      case L'\t': escaped += L"\\t"; break;
      default:
        if (character < 0x20) {
          wchar_t code[7] = {};
          swprintf_s(code, ARRAYSIZE(code), L"\\u%04x",
                     static_cast<unsigned>(character));
          escaped += code;
        } else {
          escaped += character;
        }
    }
  }
  return escaped;
}

// `--arg=<path>` for every selected item. The spirit takes JSON instead of a
// bare path, one object per item: {"kind":"file","target":"<path>","requester":"shell"}.
void AppendSelectionArgs(IShellItemArray* items, std::wstring& parameters,
                         bool spiritJson) {
  if (items == nullptr) return;
  ComPtr<IEnumShellItems> enumerator;
  if (FAILED(items->EnumItems(enumerator.ReleaseAndGetAddressOf())) || enumerator == nullptr) {
    return;
  }
  for (;;) {
    ComPtr<IShellItem> item;
    ULONG fetched = 0;
    const HRESULT next =
        enumerator->Next(1, item.ReleaseAndGetAddressOf(), &fetched);
    if (next != S_OK || fetched != 1 || item == nullptr) break;

    PWSTR path = nullptr;
    if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path != nullptr) {
      parameters += L" --arg=";
      if (spiritJson) {
        std::wstring json = L"{\"kind\":\"file\",\"target\":\"";
        json += JsonEscape(path);
        json += L"\",\"requester\":\"shell\"}";
        parameters += QuoteArg(json);
      } else {
        parameters += QuoteArg(path);
      }
      CoTaskMemFree(path);
    }
  }
}

HRESULT LaunchDesk(const wchar_t* commandId, IShellItemArray* items) {
  std::wstring parameters = L"--run=";
  parameters += commandId;
  AppendSelectionArgs(items, parameters, std::wstring(commandId) == L"spirit.go");

  // Resolve at click time, never at registration time: the desk may move, and
  // an unpackaged run is electron.exe plus an app-dir argument. The recorded
  // command line already carries its own quoting, so append our arguments to
  // it verbatim and hand the whole line to CreateProcessW.
  std::wstring executable = ReadLaunchCommand();
  if (executable.empty()) {
    const std::wstring desk = FindDeskExe();
    if (desk.empty()) {
      MessageBoxW(nullptr, L"Aither desk not found - start awdesk once",
                  kProductName, MB_OK | MB_ICONWARNING);
      return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
    }
    executable = QuoteArg(desk);
  }

  std::wstring commandLine = executable + L" " + parameters;
  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process = {};
  if (!CreateProcessW(nullptr, &commandLine[0], nullptr, nullptr, FALSE,
                      CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &startup,
                      &process)) {
    const DWORD error = GetLastError();
    return HRESULT_FROM_WIN32(error == ERROR_SUCCESS ? ERROR_ACCESS_DENIED : error);
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return S_OK;
}

HRESULT IconString(PWSTR* icon) {
  if (icon == nullptr) return E_POINTER;
  std::wstring value = ModulePath();
  if (value.empty()) return E_FAIL;
  value += L",-";
  value += std::to_wstring(kIconResourceId);
  return SHStrDupW(value.c_str(), icon);
}

class AitherVerbCommand final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IExplorerCommand> {
 public:
  explicit AitherVerbCommand(const Verb& verb) : verb_(verb) {}

  IFACEMETHODIMP GetTitle(IShellItemArray*, PWSTR* title) override {
    return SHStrDupW(verb_.title, title);
  }

  IFACEMETHODIMP GetIcon(IShellItemArray*, PWSTR* icon) override {
    return IconString(icon);
  }

  IFACEMETHODIMP GetToolTip(IShellItemArray*, PWSTR* tooltip) override {
    return SHStrDupW(verb_.tooltip, tooltip);
  }

  IFACEMETHODIMP GetCanonicalName(GUID* canonicalName) override {
    if (canonicalName == nullptr) return E_POINTER;
    *canonicalName = GUID_NULL;
    return S_OK;
  }

  IFACEMETHODIMP GetState(IShellItemArray*, BOOL, EXPCMDSTATE* state) override {
    if (state == nullptr) return E_POINTER;
    *state = ECS_ENABLED;
    return S_OK;
  }

  IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
    if (flags == nullptr) return E_POINTER;
    *flags = ECF_DEFAULT;
    return S_OK;
  }

  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** commands) override {
    if (commands == nullptr) return E_POINTER;
    *commands = nullptr;
    return E_NOTIMPL;
  }

  IFACEMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) override {
    return LaunchDesk(verb_.id, items);
  }

 private:
  Verb verb_;
};

class VerbEnumerator final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IEnumExplorerCommand> {
 public:
  explicit VerbEnumerator(ULONG index = 0) : index_(index) {}

  IFACEMETHODIMP Next(ULONG count, IExplorerCommand** commands,
                      ULONG* fetched) override {
    if (commands == nullptr && count != 0) return E_POINTER;
    if (fetched == nullptr && count != 1) return E_INVALIDARG;

    ULONG written = 0;
    while (written < count && index_ < ARRAYSIZE(kVerbs)) {
      ComPtr<AitherVerbCommand> command = Make<AitherVerbCommand>(kVerbs[index_]);
      if (command == nullptr) {
        if (fetched != nullptr) *fetched = written;
        return E_OUTOFMEMORY;
      }
      commands[written++] = command.Detach();
      ++index_;
    }
    if (fetched != nullptr) *fetched = written;
    return written == count ? S_OK : S_FALSE;
  }

  IFACEMETHODIMP Skip(ULONG count) override {
    index_ += count;
    if (index_ > ARRAYSIZE(kVerbs)) {
      index_ = ARRAYSIZE(kVerbs);
      return S_FALSE;
    }
    return S_OK;
  }

  IFACEMETHODIMP Reset() override {
    index_ = 0;
    return S_OK;
  }

  IFACEMETHODIMP Clone(IEnumExplorerCommand** clone) override {
    if (clone == nullptr) return E_POINTER;
    *clone = nullptr;
    // RuntimeClass deletes operator new on purpose; Make<> is the only way.
    ComPtr<VerbEnumerator> copy = Make<VerbEnumerator>(index_);
    if (copy == nullptr) return E_OUTOFMEMORY;
    *clone = copy.Detach();
    return S_OK;
  }

 private:
  ULONG index_;
};

class AitherShellMenuCommand final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IExplorerCommand> {
 public:
  IFACEMETHODIMP GetTitle(IShellItemArray*, PWSTR* title) override {
    return SHStrDupW(kProductName, title);
  }

  IFACEMETHODIMP GetIcon(IShellItemArray*, PWSTR* icon) override {
    return IconString(icon);
  }

  IFACEMETHODIMP GetToolTip(IShellItemArray*, PWSTR* tooltip) override {
    return SHStrDupW(L"Capture, record, draw, take notes, or ask Aither", tooltip);
  }

  IFACEMETHODIMP GetCanonicalName(GUID* canonicalName) override {
    if (canonicalName == nullptr) return E_POINTER;
    *canonicalName = GUID_NULL;
    return S_OK;
  }

  IFACEMETHODIMP GetState(IShellItemArray*, BOOL, EXPCMDSTATE* state) override {
    if (state == nullptr) return E_POINTER;
    *state = ECS_ENABLED;
    return S_OK;
  }

  IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
    if (flags == nullptr) return E_POINTER;
    *flags = ECF_HASSUBCOMMANDS;
    return S_OK;
  }

  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** commands) override {
    if (commands == nullptr) return E_POINTER;
    *commands = nullptr;
    ComPtr<VerbEnumerator> enumerator = Make<VerbEnumerator>(0);
    if (enumerator == nullptr) return E_OUTOFMEMORY;
    *commands = enumerator.Detach();
    return S_OK;
  }

  // A click on the parent (rather than a verb) asks Aither about the screen.
  IFACEMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) override {
    return LaunchDesk(L"orb.ask-screen", items);
  }
};

class ClassFactory final : public IClassFactory {
 public:
  IFACEMETHODIMP QueryInterface(REFIID iid, void** object) override {
    if (object == nullptr) return E_POINTER;
    if (iid == IID_IUnknown || iid == IID_IClassFactory) {
      *object = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  IFACEMETHODIMP_(ULONG) AddRef() override {
    return InterlockedIncrement(&references_);
  }

  IFACEMETHODIMP_(ULONG) Release() override {
    const ULONG remaining = InterlockedDecrement(&references_);
    if (remaining == 0) delete this;
    return remaining;
  }

  IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID iid, void** object) override {
    if (object == nullptr) return E_POINTER;
    *object = nullptr;
    if (outer != nullptr) return CLASS_E_NOAGGREGATION;

    ComPtr<AitherShellMenuCommand> command = Make<AitherShellMenuCommand>();
    if (command == nullptr) return E_OUTOFMEMORY;
    return command->QueryInterface(iid, object);
  }

  IFACEMETHODIMP LockServer(BOOL) override { return S_OK; }

 private:
  LONG references_ = 1;
};

}  // namespace

BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }

// STDAPI matches the declaration in combaseapi.h exactly; the exports come
// from src/exports.def, because adding __declspec(dllexport) here is a C2375
// linkage clash with that declaration.
STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** object) {
  if (object == nullptr) return E_POINTER;
  if (!IsEqualCLSID(clsid, CLSID_AitherShellMenu)) return CLASS_E_CLASSNOTAVAILABLE;

  ClassFactory* factory = new (std::nothrow) ClassFactory();
  if (factory == nullptr) return E_OUTOFMEMORY;
  const HRESULT result = factory->QueryInterface(iid, object);
  factory->Release();
  return result;
}

STDAPI DllCanUnloadNow() {
  // Explorer may cache the handler for the life of the shell; keeping it
  // loaded is cheaper than a racy unload path for a menu-construction DLL.
  return S_FALSE;
}
