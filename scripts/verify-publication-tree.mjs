import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { capture, run } from "./lib/process.mjs";
import { repoRoot } from "./lib/config.mjs";
import { systemTool } from "./lib/system-tools.mjs";

// Git and tar are resolved per host: macOS keeps their absolute system paths,
// Windows resolves both through PATH (Git for Windows plus the in-box bsdtar).
const git = systemTool("git");
const tar = systemTool("tar");
// `git ls-tree`/`git ls-files` always report forward slashes, but Windows pipes
// carry CRLF, so the inventories are split on either line ending.
const trackedLines = text => text.split(/\r?\n/).filter(Boolean);
const scratch = await mkdtemp(path.join(os.tmpdir(), "grok-bot-publication-"));
const archive = path.join(scratch, "repository.tar");
const exported = path.join(scratch, "exported");

try {
  await run(git, ["archive", "--format=tar", `--output=${archive}`, "HEAD"], { cwd: repoRoot });
  await mkdir(exported);
  await run(tar, ["-xf", archive, "-C", exported]);
  await run(git, ["init", "--quiet"], { cwd: exported });
  await run(git, ["add", "--all"], { cwd: exported });

  const [sourceTree, exportedTree, sourceFiles, exportedFiles] = await Promise.all([
    capture(git, ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot }),
    capture(git, ["write-tree"], { cwd: exported }),
    capture(git, ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repoRoot }),
    capture(git, ["ls-files"], { cwd: exported }),
  ]);
  if (sourceTree !== exportedTree) {
    const sourceSet = new Set(trackedLines(sourceFiles));
    const exportedSet = new Set(trackedLines(exportedFiles));
    const omitted = [...sourceSet].filter(file => !exportedSet.has(file));
    const unexpected = [...exportedSet].filter(file => !sourceSet.has(file));
    throw new Error(`Fresh publication export changed the tracked tree. Omitted: ${omitted.slice(0, 20).join(", ") || "none"}. Unexpected: ${unexpected.slice(0, 20).join(", ") || "none"}.`);
  }

  const ignoredSource = "frontend/src/recovered/ui/sand-form-primitives.css";
  if (!(await readFile(path.join(exported, ignoredSource))).byteLength) {
    throw new Error(`Fresh publication export omitted ${ignoredSource}`);
  }
  console.log(`Publication export preserves ${trackedLines(sourceFiles).length} files and tree ${sourceTree}.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
