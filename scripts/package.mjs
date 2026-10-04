import { isWindowsRuntimeHost } from "./lib/config.mjs";

// One entry point for `npm run package`. The two payload shapes and their
// signing models differ enough that each platform keeps its own script; this
// dispatcher only selects between them, so the macOS behaviour is unchanged and
// Windows never touches the macOS-only verification or codesign tooling.
await import(isWindowsRuntimeHost ? "./package-windows.mjs" : "./package-macos.mjs");
