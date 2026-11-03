// Desk.exe -- the per-user sparse-package launcher stub.
//
// A sparse package manifest must name an Application/@Executable that resolves
// inside its ExternalLocation. When awdesk runs unpackaged there is no Desk.exe
// to point at: the desk is `"<electron.exe>" "<app dir>"`, possibly on another
// drive. The install script therefore copies this tiny stub to the
// ExternalLocation root as Desk.exe.
//
// It launches the command line main.cjs records on every desk start under
// HKCU\Software\Aither\Desk\LaunchCommand, forwarding any arguments it was
// given (the shell-menu DLL appends --run=<id> --arg=<path>). The DLL normally
// resolves that value itself; this stub is its fallback, so a click still
// reaches the desk install.
//
// Built statically (/MT) so it needs no VC++ redistributable, exactly like the
// shell-menu DLL.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")

namespace {

constexpr wchar_t kProductName[] = L"Aither";

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

// CommandLineToArgvW-compatible quoting, so a path with spaces survives the
// forwarding hop unchanged.
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

// Our own arguments (without argv[0]), re-quoted for the desk's argv.
std::wstring ForwardedArguments() {
  int count = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &count);
  if (argv == nullptr) return {};
  std::wstring arguments;
  for (int index = 1; index < count; ++index) {
    arguments += L' ';
    arguments += QuoteArg(argv[index]);
  }
  LocalFree(argv);
  return arguments;
}

int Launch() {
  std::wstring command = ReadLaunchCommand();
  if (command.empty()) {
    MessageBoxW(nullptr, L"Aither desk not found - start awdesk once",
                kProductName, MB_OK | MB_ICONWARNING);
    return 1;
  }

  command += ForwardedArguments();
  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process = {};
  if (!CreateProcessW(nullptr, &command[0], nullptr, nullptr, FALSE,
                      CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &startup,
                      &process)) {
    MessageBoxW(nullptr, L"Aither could not be started.", kProductName,
                MB_OK | MB_ICONERROR);
    return 1;
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return 0;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) { return Launch(); }
