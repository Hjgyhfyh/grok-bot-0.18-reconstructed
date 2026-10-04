/**
 * A folder id becomes a directory name, so it must survive the filesystem of
 * every host that can open it — not only the host that created it.
 *
 * The rules split into two groups. The first group covers separators, NUL and
 * other control characters, which break path handling and terminal output on
 * every platform. The second group covers the Win32 rules, and it applies only
 * on Windows so that a POSIX host keeps names such as `notes:2024` that it can
 * list perfectly well.
 */

/** `< > : " | ? *` — the characters Win32 refuses inside a name. */
const WINDOWS_ILLEGAL_CHARACTER = /[<>:"|?*]/;

/**
 * `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9` and the superscript
 * forms `COM¹`/`LPT¹`. A reserved stem stays reserved with an extension, so
 * `CON.txt` names the console device and not a file.
 */
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/** C0 controls, DEL, and the C1 range. Checked by code point, not by regex. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Win32 strips trailing dots and spaces off a name, so `a.` and `a ` cannot be
 * opened by PowerShell, cmd, Explorer or any other ordinary consumer. Node
 * round-trips them only because it prefixes `\\?\`, which disables that
 * stripping — the directory round-trips here and nowhere else. A name no Win32
 * consumer can open is refused rather than created, because a directory the app
 * creates and then cannot list is worse than a rejected id.
 */
const WINDOWS_TRAILING_DOT_OR_SPACE = /[. ]$/;

export function isSafeFolderId(id: unknown, platform: NodeJS.Platform = process.platform): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  if (hasControlCharacter(id)) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  if (id === "." || id === "..") return false;
  if (platform !== "win32") return true;
  if (WINDOWS_ILLEGAL_CHARACTER.test(id)) return false;
  if (WINDOWS_TRAILING_DOT_OR_SPACE.test(id)) return false;
  if (WINDOWS_RESERVED_DEVICE_NAME.test(id)) return false;
  return true;
}