import { copyFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "./store-db.js";
export function removeSqliteSidecars(dbPath: string): void { for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) try { rmSync(`${dbPath}${suffix}`, { force: true, recursive: true }); } catch {} }
export function removePathWithRetries(options: { path: string; attempts?: number | undefined; retryDelayMs?: number | undefined; recursive?: boolean | undefined }): void { const attempts = Math.max(1, options.attempts ?? 1); let failure: unknown; for (let attempt = 0; attempt < attempts; attempt += 1) { try { rmSync(options.path, { force: true, recursive: options.recursive === true }); failure = undefined; break; } catch (error) { failure = error; if (attempt < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.retryDelayMs ?? 50); } } if (failure != null) throw failure; }
export function removeSqliteDb(options: { dbPath: string; attempts?: number | undefined; retryDelayMs?: number | undefined }): void { removePathWithRetries({ path: options.dbPath, attempts: options.attempts, retryDelayMs: options.retryDelayMs }); for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) removePathWithRetries({ path: `${options.dbPath}${suffix}`, attempts: options.attempts, retryDelayMs: options.retryDelayMs, recursive: true }); }
export function quarantineCorruptSqliteDb(options: { dbPath: string; quarantinePath?: string; preserveSourceOnCopyFailure?: boolean; removeAttempts?: number | undefined; removeRetryDelayMs?: number | undefined }): { quarantinePath: string | null; copied: boolean; renameErrorCode: string | null } { const stamp = new Date().toISOString().replace(/[:.]/g, "-"), quarantinePath = options.quarantinePath ?? `${options.dbPath}.corrupt-${stamp}`; try { rmSync(quarantinePath, { force: true }); removeSqliteSidecars(quarantinePath); } catch {} try { renameSync(options.dbPath, quarantinePath); } catch (error) { const renameErrorCode = String((error as { code?: unknown }).code ?? "error"); let copied = false; try { copyFileSync(options.dbPath, quarantinePath); copied = true; for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) if (existsSync(`${options.dbPath}${suffix}`)) try { copyFileSync(`${options.dbPath}${suffix}`, `${quarantinePath}${suffix}`); } catch {} } catch { if (options.preserveSourceOnCopyFailure === true) return { quarantinePath: options.dbPath, copied: false, renameErrorCode }; } removeSqliteDb({ dbPath: options.dbPath, attempts: options.removeAttempts, retryDelayMs: options.removeRetryDelayMs }); return { quarantinePath: copied ? quarantinePath : null, copied, renameErrorCode }; } for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) try { const sidecar = `${options.dbPath}${suffix}`; if (existsSync(sidecar)) renameSync(sidecar, `${quarantinePath}${suffix}`); } catch { rmSync(`${options.dbPath}${suffix}`, { force: true }); } return { quarantinePath, copied: false, renameErrorCode: null }; }
/**
 * The suffix the carve scratch file takes. It lives beside the database it was
 * copied from, never outside that directory, and both callers of
 * `openSqliteForSalvage` pass a path they already own: a quarantine file
 * produced by `quarantineCorruptSqliteDb`.
 */
export const SQLITE_CARVE_SUFFIX = ".salvage-carve";
const SQLITE_HEADER_BYTES = 100;
const SQLITE_HEADER_MAGIC = "SQLite format 3\0";
/** Byte offsets inside the fixed 100-byte SQLite database header. */
const HEADER_PAGE_COUNT_OFFSET = 28;
const HEADER_FREELIST_TRUNK_OFFSET = 32;
const HEADER_FREELIST_COUNT_OFFSET = 36;

function sqlitePageSize(header: Buffer): number | null {
  const raw = header.readUInt16BE(16);
  const pageSize = raw === 1 ? 65_536 : raw;
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0)
    return null;
  return pageSize;
}

function readSqliteHeader(dbPath: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(dbPath, "r");
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    return readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0) === SQLITE_HEADER_BYTES
      ? header
      : null;
  } catch {
    return null;
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
  }
}

function writeSqliteHeader(dbPath: string, header: Buffer): void {
  let fd: number | undefined;
  try {
    fd = openSync(dbPath, "r+");
    writeSync(fd, header, 0, SQLITE_HEADER_BYTES, 0);
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
  }
}

/**
 * Opens a database whose header claims more pages than the file still holds.
 *
 * A store that lost its tail — a copy interrupted, a restore that ran out of
 * space, a full disk — keeps every page it did write. The header still declares
 * the page count from before the loss, and SQLite refuses the whole file on
 * sight: its first statement raises `SQLITE_CORRUPT`, so
 * `copySalvageableSqliteRows` breaks out of its loop on the first row and the
 * salvage reports zero. Measured on a 2000-entry `store.db` truncated by a
 * single 4 KiB page: every one of the 2000 entries was still physically in the
 * file, and recovery kept 0 of them. The same file with 4 KiB flipped in the
 * middle instead of a shortened tail kept 993, because a full-length file only
 * loses the rows past the damage.
 *
 * The salvage already tolerates a read failing part way through a table — that
 * is what its loop is for. All it lacks is a way to get past the first
 * statement. Lowering the header's page count to the pages that are actually
 * there gives it one: the tables become readable up to the truncation point and
 * the scan stops there, which is the most any reader can return from a short
 * file.
 *
 * The quarantine file is the evidence, so the header is rewritten on a copy
 * beside it and that copy is removed when the returned handle is closed. The
 * source is never opened for writing.
 *
 * Returns `undefined` when the file is not a SQLite database, when the header
 * is too short or unreadable, or when it does not over-declare its page count —
 * in all of those cases there is nothing to carve and the caller keeps whatever
 * it had.
 */
export function openTruncatedSqliteForSalvage(options: { dbPath: string; busyTimeoutMs?: number }): DatabaseSync | undefined {
  let size: number;
  try {
    size = statSync(options.dbPath).size;
  } catch {
    return undefined;
  }
  if (size < SQLITE_HEADER_BYTES) return undefined;
  const header = readSqliteHeader(options.dbPath);
  if (header == null || header.toString("latin1", 0, 16) !== SQLITE_HEADER_MAGIC) return undefined;
  const pageSize = sqlitePageSize(header);
  if (pageSize == null) return undefined;
  const presentPages = Math.floor(size / pageSize);
  if (presentPages < 1 || header.readUInt32BE(HEADER_PAGE_COUNT_OFFSET) <= presentPages) return undefined;
  const scratchPath = `${options.dbPath}${SQLITE_CARVE_SUFFIX}`;
  try {
    copyFileSync(options.dbPath, scratchPath);
    const patched = Buffer.from(header);
    patched.writeUInt32BE(presentPages, HEADER_PAGE_COUNT_OFFSET);
    patched.writeUInt32BE(0, HEADER_FREELIST_TRUNK_OFFSET);
    patched.writeUInt32BE(0, HEADER_FREELIST_COUNT_OFFSET);
    writeSqliteHeader(scratchPath, patched);
    const carved = new DatabaseSync(scratchPath);
    if (options.busyTimeoutMs != null) carved.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    carved.prepare("PRAGMA schema_version").get();
    const close = carved.close.bind(carved);
    carved.close = () => {
      try { close(); } finally { removeSqliteSidecars(scratchPath); try { rmSync(scratchPath, { force: true }); } catch {} }
    };
    return carved;
  } catch {
    removeSqliteSidecars(scratchPath);
    try { rmSync(scratchPath, { force: true }); } catch {}
    return undefined;
  }
}
export function openSqliteForSalvage(options: { dbPath: string; busyTimeoutMs?: number }): DatabaseSync | undefined { if (!existsSync(options.dbPath)) return undefined; const open = () => { const db = new DatabaseSync(options.dbPath); try { if (options.busyTimeoutMs != null) db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`); db.prepare("PRAGMA schema_version").get(); return db; } catch (error) { try { db.close(); } catch {} throw error; } }; try { return open(); } catch { removeSqliteSidecars(options.dbPath); try { return open(); } catch { const carved = openTruncatedSqliteForSalvage(options); if (carved != null) return carved; try { return new DatabaseSync(options.dbPath); } catch { return undefined; } } } }
export function copySalvageableSqliteRows(source: { prepare(sql: string): { iterate(): Iterator<unknown> } }, selectSql: string, insert: { run(...params: unknown[]): unknown }, toParams: (row: unknown) => unknown[]): number { let iterator: Iterator<unknown>; try { iterator = source.prepare(selectSql).iterate(); } catch { return 0; } let copied = 0; try { for (;;) { let next: IteratorResult<unknown>; try { next = iterator.next(); } catch { break; } if (next.done) break; try { insert.run(...toParams(next.value)); copied += 1; } catch {} } } finally { try { iterator.return?.(); } catch {} } return copied; }
