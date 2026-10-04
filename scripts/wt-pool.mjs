import { access, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repoRoot } from "./lib/config.mjs";
import { capture, run } from "./lib/process.mjs";
import { systemTool } from "./lib/system-tools.mjs";

// Git worktrees exist because two agents edited one file in one directory and
// silently overwrote each other, which read as type-checker flakiness because
// the error counts moved on files neither agent had touched. A worktree gives
// each agent its own checkout over one shared object database, so an overwrite
// becomes impossible by construction instead of by discipline.
//
// The pool is deliberately small. This repository tracks its renderer payload
// and its original installers through git-lfs, and a checkout that smudges them
// costs about 420 MB against the 26 GB of free space left on drive D. Skipping
// the smudge is what keeps four worktrees affordable; docs/WORKTREES.md carries
// the measured numbers and explains what a pointer file means to an agent that
// runs a build in one.
//
// Nothing here pushes, fetches by default, builds, or packages. The remote
// belongs to the human operator, and the build writes into directories other
// agents are reading.

const git = systemTool("git");

// `git worktree list --porcelain` always lists the main worktree first, which is
// the only reason the first block can be trusted as the pool's anchor: a copy of
// this script inside a worktree resolves `repoRoot` to that worktree, and
// anchoring on it would nest one pool inside another checkout.
function parseWorktreePorcelain(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const split = line.indexOf(" ");
    const key = line.slice(0, split);
    const value = split === -1 ? "" : line.slice(split + 1);
    if (key === "worktree") records.push({ path: value, head: null, branch: null, locked: false, prunable: false });
    else if (records.length === 0) continue;
    else if (key === "HEAD") records.at(-1).head = value;
    else if (key === "branch") records.at(-1).branch = value.replace(/^refs\/heads\//, "");
    else if (key === "locked") records.at(-1).locked = true;
    else if (key === "prunable") records.at(-1).prunable = true;
  }
  return records;
}

const [primaryWorktree] = parseWorktreePorcelain(
  await capture(git, ["worktree", "list", "--porcelain"], { cwd: repoRoot }),
);
if (primaryWorktree === undefined) throw new Error(`${repoRoot} is not inside a git worktree.`);

const primaryRoot = path.resolve(primaryWorktree.path);
const baseBranch = process.env.GROK_BOT_WT_BASE?.trim() || "main";
const poolRoot = path.resolve(process.env.GROK_BOT_WT_POOL?.trim() || path.join(path.dirname(primaryRoot), "worktrees"));
const claimsDir = path.join(poolRoot, ".claims");
const lockDir = path.join(poolRoot, ".lock");
const branchPrefix = "wt/";
const defaultLabel = "agent";
// Four is the disk budget, not an arbitrary number. A full-LFS checkout is
// ~420 MB, so an unbounded pool is how this drive fills up and takes the main
// working tree's `dist/` and `.build/` with it. Raise it with `--max` only after
// measuring, never because an agent is waiting.
const defaultPoolCap = 4;
// A lock directory is a `mkdir`, which is atomic on every platform this repo
// runs on. Two agents mutating refs in one pool at the same time reproduces
// exactly the silent corruption the pool exists to prevent, so the mutating
// commands take the lock and `list` does not.
const lockStaleAfterMs = 30 * 60 * 1000;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function directoryBytes(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true, recursive: true });
    const sizes = await Promise.all(entries
      .filter(entry => entry.isFile())
      .map(entry => stat(path.join(entry.parentPath ?? entry.path, entry.name)).then(info => info.size, () => 0)));
    return sizes.reduce((total, size) => total + size, 0);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[name] = true;
    else {
      options[name] = next;
      index++;
    }
  }
  return { positional, options };
}

function optionString(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (value === true) throw new Error(`--${name} needs a value`);
  return String(value);
}

// NTFS still resolves these to a DOS device even with an extension, so a
// worktree named after one fails at checkout with an error that names neither
// the real path nor the reserved word.
const windowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// The pool lives on a case-insensitive filesystem, so two labels that differ
// only in case are distinct branches to git and the same directory to the disk.
// Normalising to lower case at claim time keeps `list` and Explorer describing
// the same set of slots.
function normalizeLabel(raw) {
  const label = String(raw ?? defaultLabel)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (label.length === 0) throw new Error(`A worktree label must keep at least one letter or digit, got "${raw}"`);
  if (label.length > 32) throw new Error(`A worktree label must be 32 characters or fewer, got ${label.length}`);
  if (windowsReservedName.test(label)) throw new Error(`"${label}" is a reserved Windows device name and cannot name a directory`);
  return label;
}

function slotName(label, index) {
  return `${label}-${String(index).padStart(2, "0")}`;
}

function renderTable(rows, columns) {
  return [
    columns.map(column => column.title.padEnd(column.width)).join("  "),
    ...rows.map(row => columns.map(column => String(column.value(row)).padEnd(column.width)).join("  ")),
  ].join("\n");
}

async function countDirtyLines(worktreePath) {
  const text = await capture(git, ["status", "--porcelain"], { cwd: worktreePath });
  return text.length === 0 ? 0 : text.split(/\r?\n/).filter(Boolean).length;
}

async function requirePoolRoot() {
  const parent = path.dirname(poolRoot);
  if (!(await isDirectory(parent))) {
    throw new Error(`The pool's parent directory does not exist: ${parent}. Create it, or point GROK_BOT_WT_POOL somewhere else.`);
  }
  await mkdir(poolRoot, { recursive: true });
  return poolRoot;
}

function inPool(worktreePath) {
  const relative = path.relative(poolRoot, path.resolve(worktreePath));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function poolRecords() {
  const records = parseWorktreePorcelain(await capture(git, ["worktree", "list", "--porcelain"], { cwd: primaryRoot }));
  return records.filter(record => inPool(record.path));
}

async function requirePoolRecord(name) {
  const records = await poolRecords();
  const record = records.find(candidate => path.basename(path.resolve(candidate.path)) === name);
  if (!record) {
    const known = records.map(candidate => path.basename(path.resolve(candidate.path))).join(", ") || "none";
    throw new Error(`${name} is not a worktree in ${poolRoot}. The pool holds: ${known}`);
  }
  return record;
}

function currentOwner(options = {}) {
  const explicit = options.owner === true ? null : options.owner;
  const owner = explicit ?? process.env.GROK_BOT_WT_OWNER?.trim() ?? "";
  return owner.length > 0 ? owner : `${os.userInfo().username}@${os.hostname()}`;
}

// A claim is written beside the pool, never inside the checkout. An untracked
// file inside the worktree would make `git status` dirty, and `git status` is the
// only signal `sync` and `remove` have for "this agent is mid-edit".
function claimPath(name) {
  return path.join(claimsDir, `${name}.json`);
}

async function readClaim(name) {
  try {
    return JSON.parse(await readFile(claimPath(name), "utf8"));
  } catch {
    return null;
  }
}

async function writeClaim(name, owner) {
  await mkdir(claimsDir, { recursive: true });
  await writeFile(claimPath(name), `${JSON.stringify({
    name,
    owner,
    pid: process.pid,
    host: os.hostname(),
    claimedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

// `npm ci` and `npm install` in a worktree would rewrite this one directory under
// every other agent, and `postinstall` patches files inside it. The junction is
// what makes `npm test` and `tsc` runnable for the price of an inode instead of a
// 434 MB copy per slot; the prohibition belongs in docs/WORKTREES.md.
async function linkDependencies(target) {
  const source = path.join(primaryRoot, "node_modules");
  const link = path.join(target, "node_modules");
  if (!(await isDirectory(source))) return "skipped: no node_modules in main";
  if (await exists(link)) return "already present";
  await symlink(source, link, "junction");
  return "linked to main node_modules";
}

async function acquirePoolLock(force) {
  await requirePoolRoot();
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let holder = null;
    let age = null;
    try {
      holder = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
      age = Date.now() - Date.parse(holder?.since);
    } catch {
      holder = null;
    }
    const stale = Number.isFinite(age) && age > lockStaleAfterMs;
    if (!force && !stale) {
      throw new Error(`The pool is locked by ${holder ? `${holder.owner} (pid ${holder.pid})` : "another process"}. Wait for it, or pass --force-lock if it is gone.`);
    }
    console.warn(`Taking over a ${stale ? "stale" : "forced"} pool lock left by ${holder?.owner ?? "an unknown process"}.`);
    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir);
  }
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
    owner: currentOwner(),
    pid: process.pid,
    since: new Date().toISOString(),
  })}\n`, "utf8");
  return async () => await rm(lockDir, { recursive: true, force: true });
}

async function describeWorktree(record, { withSize }) {
  const name = path.basename(path.resolve(record.path));
  const present = await isDirectory(record.path);
  const branch = record.branch;
  return {
    name,
    path: record.path,
    branch: branch ?? "(detached)",
    head: record.head === null ? "(unborn)" : record.head.slice(0, 8),
    dirty: present ? await countDirtyLines(record.path) : null,
    ahead: branch === null ? null : Number(await capture(git, ["rev-list", "--count", `${baseBranch}..${branch}`], { cwd: primaryRoot })),
    behind: branch === null ? null : Number(await capture(git, ["rev-list", "--count", `${branch}..${baseBranch}`], { cwd: primaryRoot })),
    claim: await readClaim(name),
    bytes: withSize && present ? await directoryBytes(record.path) : null,
  };
}

async function listCommand(options) {
  const withSize = options["no-size"] !== true;
  const records = await poolRecords();
  if (records.length === 0) {
    console.log(`The pool at ${poolRoot} is empty. Run: node scripts/wt-pool.mjs create 4`);
    return;
  }
  const rows = [];
  for (const record of records) rows.push(await describeWorktree(record, { withSize }));
  console.log(`Pool ${poolRoot}`);
  console.log(`Base ${baseBranch}  main tree ${primaryRoot}`);
  console.log(renderTable(rows, [
    { title: "NAME", width: 18, value: row => row.name },
    { title: "BRANCH", width: 20, value: row => row.branch },
    { title: "HEAD", width: 9, value: row => row.head },
    { title: "DIRTY", width: 5, value: row => row.dirty ?? "-" },
    { title: "AHEAD", width: 5, value: row => row.ahead ?? "-" },
    { title: "BEHIND", width: 6, value: row => row.behind ?? "-" },
    { title: "OWNER", width: 24, value: row => row.claim?.owner ?? "-" },
    { title: "MB", width: 7, value: row => row.bytes === null ? "-" : (row.bytes / 1024 / 1024).toFixed(1) },
  ]));
  const totalBytes = rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
  const dirtyNames = rows.filter(row => row.dirty > 0).map(row => row.name);
  const handoffNames = rows.filter(row => (row.ahead ?? 0) > 0).map(row => row.name);
  console.log(`${rows.length} worktree(s), ${withSize ? `${(totalBytes / 1024 / 1024).toFixed(1)} MB total on disk` : "size not measured (--no-size)"}.`);
  if (dirtyNames.length > 0) console.log(`Uncommitted work in: ${dirtyNames.join(", ")} — sync and remove leave these alone.`);
  if (handoffNames.length > 0) console.log(`Commits to hand back: ${handoffNames.join(", ", " ")} — see docs/WORKTREES.md.`);
}

async function createCommand(count, options) {
  const label = normalizeLabel(optionString(options, "label", defaultLabel));
  const fullLfs = options["full-lfs"] === true;
  const withDeps = options["no-deps"] !== true;
  const cap = Number(optionString(options, "max", String(defaultPoolCap)));
  const forceLock = options["force-lock"] === true;
  if (!Number.isInteger(count) || count < 1) throw new Error(`create needs a positive count, got ${JSON.stringify(count)}`);
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`--max needs a positive integer, got ${JSON.stringify(cap)}`);

  const release = await acquirePoolLock(forceLock);
  try {
    const existing = await poolRecords();
    if (existing.length + count > cap) {
      throw new Error(`Refusing to exceed the pool cap: ${existing.length} exist, ${count} requested, cap ${cap}. Raise it with --max after measuring free space.`);
    }
    const taken = new Set(existing.map(record => path.basename(path.resolve(record.path))));
    const created = [];
    for (let index = 1; index <= 99 && created.length < count; index++) {
      const name = slotName(label, index);
      if (taken.has(name)) continue;
      taken.add(name);
      const target = path.join(poolRoot, name);
      const branch = branchPrefix + name;
      // GIT_LFS_SKIP_SMUDGE is passed to this one git process only. It is never
      // written into `.git/config`, because that config is shared by every
      // worktree and would quietly turn the main tree's payload into pointers.
      const env = { ...process.env };
      if (fullLfs) delete env.GIT_LFS_SKIP_SMUDGE;
      else env.GIT_LFS_SKIP_SMUDGE = "1";
      console.log(`Creating ${name} on ${branch}${fullLfs ? " (full LFS checkout)" : " (LFS pointers only)"} …`);
      await run(git, ["worktree", "add", "-b", branch, target, baseBranch], { cwd: primaryRoot, env });
      await writeClaim(name, currentOwner(options));
      created.push({
        name,
        path: target,
        branch,
        deps: withDeps ? await linkDependencies(target) : "skipped: --no-deps",
        bytes: await directoryBytes(target),
      });
    }
    if (created.length < count) throw new Error(`Only ${created.length} of ${count} slot(s) were free under label "${label}".`);
    console.log(renderTable(created, [
      { title: "NAME", width: 18, value: row => row.name },
      { title: "BRANCH", width: 20, value: row => row.branch },
      { title: "PATH", width: 46, value: row => row.path },
      { title: "DEPS", width: 26, value: row => row.deps },
      { title: "MB", width: 7, value: row => (row.bytes / 1024 / 1024).toFixed(1) },
    ]));
    const totalBytes = created.reduce((total, row) => total + (row.bytes ?? 0), 0);
    console.log(`Created ${created.length} worktree(s), ${(totalBytes / 1024 / 1024).toFixed(1)} MB total.`);
    console.log(fullLfs
      ? "Full LFS payload present. A build here still needs the main agent's build slot."
      : "LFS payloads are pointer files. Run `git lfs checkout` in the worktree before reading src/app/dist.");
  } finally {
    await release();
  }
}

async function removeCommand(name, options) {
  const force = options.force === true;
  const record = await requirePoolRecord(name);
  if (path.resolve(record.path) === primaryRoot) {
    throw new Error("Refusing to remove the main working tree. The pool exists to stay out of its way.");
  }
  const dirty = await countDirtyLines(record.path);
  if (dirty > 0 && !force) {
    throw new Error(`${name} holds ${dirty} uncommitted change(s). Commit them, or pass --force to discard the working copy.`);
  }
  // The branch verdict is reached before anything is deleted, so a refusal
  // leaves the slot, the branch and the commits all still standing.
  const branch = record.branch;
  const unmerged = branch === null
    ? 0
    : Number(await capture(git, ["rev-list", "--count", `${baseBranch}..${branch}`], { cwd: primaryRoot }));
  const wantsBranchDeletion = options["delete-branch"] === true || options.branch === true;
  if (wantsBranchDeletion && unmerged > 0 && !force) {
    throw new Error(`Branch ${branch} has ${unmerged} commit(s) that are not in ${baseBranch}. Nothing was removed; pass --force to discard them.`);
  }
  const bytes = await directoryBytes(record.path);
  await run(git, ["worktree", "remove", ...(force ? ["--force"] : []), record.path], { cwd: primaryRoot });
  await rm(claimPath(name), { force: true });
  console.log(`Removed worktree ${name}, ${bytes === null ? "0" : (bytes / 1024 / 1024).toFixed(1)} MB reclaimed.`);
  if (branch === null) return;
  if (!wantsBranchDeletion) {
    console.log(`Branch ${branch} kept. Delete it with: git branch -D ${branch}`);
    return;
  }
  await run(git, ["branch", "-D", branch], { cwd: primaryRoot });
  console.log(`Deleted branch ${branch}.`);
}

// `sync` is the command an agent runs while its neighbours are mid-edit, so it
// only does the two things that cannot lose work: prune registrations whose
// directory is already gone, and fast-forward a checkout that is provably idle.
// Anything holding uncommitted changes, any branch carrying its own commits and
// any checkout it cannot read is reported and left alone. There is no reset, no
// stash, no rebase and no merge commit anywhere in this path.
async function syncCommand(name, options) {
  const base = optionString(options, "base", baseBranch);
  const dryRun = options["dry-run"] === true;
  const release = await acquirePoolLock(options["force-lock"] === true);
  try {
    // Fetch is opt-in because it touches the network on behalf of every agent
    // that runs it, and the remote is the human operator's to manage.
    if (options.fetch === true) await run(git, ["fetch", "--prune", "origin"], { cwd: primaryRoot });
    await run(git, ["worktree", "prune"], { cwd: primaryRoot });
    const baseHead = await capture(git, ["rev-parse", "--short", base], { cwd: primaryRoot });
    const results = [];
    for (const record of await poolRecords()) {
      const slot = path.basename(path.resolve(record.path));
      if (name !== undefined && slot !== name) continue;
      if (!(await isDirectory(record.path))) {
        results.push({ name: slot, outcome: "skipped", detail: "directory gone; registration pruned" });
        continue;
      }
      if (record.branch === null) {
        results.push({ name: slot, outcome: "skipped", detail: "detached HEAD, nothing to fast-forward" });
        continue;
      }
      const dirty = await countDirtyLines(record.path);
      if (dirty > 0) {
        results.push({ name: slot, outcome: "skipped", detail: `${dirty} uncommitted change(s) in the checkout` });
        continue;
      }
      const ahead = Number(await capture(git, ["rev-list", "--count", `${base}..${record.branch}`], { cwd: primaryRoot }));
      if (ahead > 0) {
        results.push({ name: slot, outcome: "skipped", detail: `${ahead} commit(s) of its own; merge or rebase it by hand` });
        continue;
      }
      const behind = Number(await capture(git, ["rev-list", "--count", `${record.branch}..${base}`], { cwd: primaryRoot }));
      if (behind === 0) {
        results.push({ name: slot, outcome: "current", detail: "already at base" });
        continue;
      }
      if (dryRun) {
        results.push({ name: slot, outcome: "would fast-forward", detail: `${behind} commit(s) behind ${base}` });
        continue;
      }
      await run(git, ["merge", "--ff-only", base], { cwd: record.path });
      results.push({ name: slot, outcome: "fast-forwarded", detail: `${behind} commit(s) to ${baseHead}` });
    }
    console.log(`Base ${base} is ${baseHead}. Pool ${poolRoot}${dryRun ? " — dry run, nothing changed" : ""}`);
    if (results.length === 0) {
      console.log(name === undefined ? "The pool is empty." : `${name} is not a worktree in the pool.`);
      return;
    }
    console.log(renderTable(results, [
      { title: "NAME", width: 18, value: row => row.name },
      { title: "OUTCOME", width: 20, value: row => row.outcome },
      { title: "DETAIL", width: 54, value: row => row.detail },
    ]));
    const skipped = results.filter(row => row.outcome === "skipped").length;
    console.log(`${results.length - skipped} at ${baseHead}, ${skipped} left untouched. No commit, ref or working file was discarded.`);
  } finally {
    await release();
  }
}

function usage() {
  return [
    "Usage: node scripts/wt-pool.mjs <command> [arguments]",
    "",
    "  create <n> [--label <name>] [--full-lfs] [--no-deps] [--max <n>] [--owner <id>]",
    "      Create n worktrees in the pool, each on its own branch off the base.",
    "  claim <label> [--full-lfs] [--no-deps] [--owner <id>]",
    "      Take the lowest free slot for one agent. The same as `create 1 --label`.",
    "  list [--no-size]",
    "      Every pooled worktree: branch, head, dirty count, commits to hand back, owner, size.",
    "  remove <name> [--force] [--delete-branch]",
    "      Remove one worktree. Refuses while the checkout holds uncommitted work.",
    "  sync [name] [--base <ref>] [--fetch] [--dry-run] [--force-lock]",
    "      Fast-forward only the worktrees that are provably idle. Discards nothing.",
    "",
    `Pool: ${poolRoot}`,
    `Base: ${baseBranch} (override with GROK_BOT_WT_BASE or --base)`,
    "Owner: GROK_BOT_WT_OWNER, or --owner <id>, or the current user@host",
  ].join("\n");
}

const [command, ...rest] = process.argv.slice(2);
const { positional, options } = parseOptions(rest);

try {
  if (command === undefined || command === "help" || options.help === true) console.log(usage());
  else if (command === "create") await createCommand(Number(positional[0]), options);
  else if (command === "claim") {
    const label = positional[0] ?? optionString(options, "label", null);
    if (label === null || label === undefined) throw new Error("claim needs a label: node scripts/wt-pool.mjs claim <your-name>");
    await createCommand(1, { ...options, label });
  } else if (command === "list") await listCommand(options);
  else if (command === "remove") {
    if (positional[0] === undefined) throw new Error("remove needs a worktree name. Run `list` to see them.");
    await removeCommand(positional[0], options);
  } else if (command === "sync") await syncCommand(positional[0], options);
  else throw new Error(`Unknown command "${command}".\n\n${usage()}`);
} catch (error) {
  // A stack trace from a pool command is noise for an agent that only needs to
  // know which slot is busy. The message is the actionable part.
  console.error(`wt-pool: ${error?.message ?? error}`);
  process.exitCode = 1;
}