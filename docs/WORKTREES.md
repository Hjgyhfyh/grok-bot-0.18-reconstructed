# Worktree pool

Dozens of agents work this repository at the same time. Twice, two agents
edited the same file in the same working directory and silently overwrote each
other. The symptom was error counts moving between 8, 3 and 0 across files
neither agent had touched, which reads as a flaky type checker rather than as
data loss.

A git worktree fixes that structurally. Each agent gets its own checkout
directory while all of them share one object database, so an overwrite stops
being a matter of discipline and becomes something the filesystem refuses.

`scripts/wt-pool.mjs` manages the pool. Run it from the main working tree.

## Where the pool lives and what it costs

The pool is a sibling of the main tree, one level up:

    D:\ТЕСТЫ\DeepSeek-Harness\grok-bot-0.18-reconstructed   main tree
    D:\ТЕСТЫ\DeepSeek-Harness\worktrees\agent-01             slot
    D:\ТЕСТЫ\DeepSeek-Harness\worktrees\agent-02             slot
    D:\ТЕСТЫ\DeepSeek-Harness\worktrees\agent-03             slot
    D:\ТЕСТЫ\DeepSeek-Harness\worktrees\agent-04             slot

Measured on this machine, 2879 tracked files:

| What | Size | Time |
| --- | --- | --- |
| Slot as created (`LFS pointers only`) | 28.8 MB | ~50 s |
| Slot after `git lfs checkout` | 420.4 MB | +218 s |
| `src/app/dist` payload | 123.1 MB | |
| `research-archives/original` (`.dmg` + `.exe`) | 268.6 MB | |
| `node_modules` as a junction | 0 bytes | |
| Whole pool of 4 | 115.3 MB | 207 s |

The pool is created with `GIT_LFS_SKIP_SMUDGE=1`, which is passed to that one
`git worktree add` process and never written into `.git/config`. That is the
whole trick: the LFS payload is 392 MB, and four materialized slots would cost
1.7 GB of a 26 GB drive for files that no agent in a slot is allowed to edit
anyway. It is set per process rather than per repository because `.git/config`
is shared by every worktree — a repository-level skip would quietly turn the
main tree's payload into pointer files too.

`.gitattributes` sends three paths through LFS, not one: `src/app/dist/**` plus
the two preserved installers under `research-archives/original/`. A slot that
needs to read `src/app/dist` runs `git lfs checkout` inside it first and pays
the 392 MB.

## Claim a worktree

From the main working tree:

```sh
node scripts/wt-pool.mjs claim <your-name> --owner <your-name>
```

It takes the lowest free slot for that label, creates the directory on a branch
named `wt/<label>-<NN>`, and records who holds it. The output prints the path to
`cd` into.

The label is normalised to lower case. The pool is on a case-insensitive
filesystem, so `Alice` and `alice` would be two branches to git and one
directory to the disk.

Useful flags:

- `--full-lfs` materialises the LFS payload in the slot (392 MB).
- `--no-deps` skips the `node_modules` junction.
- `--max <n>` raises the pool cap, which is 4. The cap is a disk budget, not a
  guess; measure before raising it.

Full pool:

```sh
node scripts/wt-pool.mjs create 4 --label agent
node scripts/wt-pool.mjs list
```

## Which one is yours

Three independent signals, in order of reliability:

1. `node scripts/wt-pool.mjs list` prints the `OWNER` column from
   `<pool>/.claims/<name>.json`.
2. From inside the slot, `git rev-parse --git-dir` prints a path ending in
   `.git/worktrees/<name>`. A path ending in `.git` alone means you are in the
   main tree and you are sharing a working directory with every other agent.
3. `git rev-parse --abbrev-ref HEAD` prints `wt/<label>-<NN>`, never `main`.

The claim file lives beside the pool, not inside the slot, on purpose: an
untracked file inside the checkout would make `git status` dirty, and a dirty
`git status` is the only signal `sync` and `remove` have for "this agent is
mid-edit".

## Hand changes back

Work inside your slot, commit on your slot's branch, and let the main tree
merge. Objects are shared, so a commit in a slot is immediately visible from
the main tree without any copying:

```sh
cd D:/ТЕСТЫ/DeepSeek-Harness/worktrees/agent-01
git add -A
git commit -m "…"
git log main..HEAD --oneline          # what you are handing back
```

From the main tree, while holding the build slot:

```sh
git merge --no-ff wt/agent-01         # review before merging
node scripts/wt-pool.mjs remove agent-01 --delete-branch
```

`remove` refuses while the checkout holds uncommitted changes, and it refuses
to delete a branch whose commits are not in the base branch. It will not run
`git push`. The remote belongs to the operator.

`list` reports the `AHEAD` column, which is exactly the number of commits that
are ready to hand back. Anything non-zero there is work that exists only in
your slot.

## What `sync` does, and what it refuses to do

`sync` is the command meant to be run while other agents are mid-edit, so it
only does the two operations that cannot lose work:

1. `git worktree prune`, which drops registrations whose directory is already
   gone. Nothing on disk is read or written.
2. `git merge --ff-only <base>` in a slot that is provably idle — clean working
   tree, no commits of its own.

Everything else is reported and left alone. There is no `reset`, no `stash`, no
`rebase` and no merge commit anywhere in that path, so `sync` cannot destroy a
commit, a ref or a working file. `--fetch` is opt-in because it touches the
network on behalf of every agent that passes it.

```sh
node scripts/wt-pool.mjs sync              # every idle slot
node scripts/wt-pool.mjs sync agent-01     # one slot
node scripts/wt-pool.mjs sync --dry-run    # decide, change nothing
```

The one thing `sync` cannot detect is an agent holding a stale editor buffer in
an otherwise clean slot. The fast-forward is correct for git and still rewrites
the files that buffer was opened against. For that case, name the single slot
and sync it after the agent says it has stopped editing.

## Never do these from inside a slot

1. **Never run `npm run build`, `npm run package`, `npm run package:diagnostic`
   or `node scripts/clean-build.mjs` without the main agent's build slot.**
   These are strictly sequential operations with no locks anywhere in the
   pipeline. Note the reason is *not* the obvious one: `scripts/lib/config.mjs`
   derives `repoRoot` from the script's own location, so a build inside a slot
   writes `<slot>/.build` and `<slot>/dist`, not the main tree's. What makes it
   expensive is disk — a build costs about 312 MB of `.build` plus 469 MB of
   `dist` **per slot**, and needs the 392 MB LFS payload materialized first. Four
   slots doing this is 3.1 GB, and the output other agents actually launch lives
   in the main tree's `dist`.

2. **Never run `npm install` or `npm ci` in a slot.** `node_modules` is a
   junction to the main tree's directory, and `postinstall` runs
   `scripts/apply-third-party-patches.mjs`, which rewrites files inside it.
   This is the one genuinely shared write path in the pool. Use the junction for
   `npm test` and `tsc` only.

3. **Never run `git lfs prune` or `git gc --prune`.** The LFS object store lives
   at `<main>/.git/lfs/objects` and is shared by every slot. Pruning it removes
   objects another slot still references.

4. **Never delete another slot's branch or directory.** `git branch -D
   wt/someone-else` and `git worktree remove <someone-else>` break a working
   directory that another agent is inside. Use `remove <name>` and only for a
   slot you hold.

5. **Never `git push`.** The remote is the operator's, and the repository's
   `pre-push` hook runs the LFS pre-push.

6. **Never edit `src/app/dist`.** Already forbidden by `AGENTS.md`, and in a
   slot it holds LFS pointer files rather than the payload — a ~130-byte text
   file starting with `version https://git-lfs.github.com/spec/v1`. Reading it
   and concluding the renderer is broken is a pointer file being read as an
   asset. Run `git lfs checkout` in the slot first.

7. **Never launch two app instances from two slots.** The user-data directory
   and the singleton lock are shared across the machine at `~/.grokbot`, not per
   checkout. The second launch is refused, and the lock belongs to whoever
   started first. Give a second instance its own `--user-data-dir`, and never
   `Stop-Process` an instance you did not launch.

8. **Never treat another agent's test counts as evidence.** They move between
   runs by design. Re-run in your own slot and report the number you observed.

## Two things the brief this pool was built from got wrong

Recorded here so the next agent does not rediscover them the hard way.

- **The LFS payload is 392 MB per slot, not 123 MB.** The 123 MB figure is
  `src/app/dist` alone. `.gitattributes` also sends
  `research-archives/original/**/*.dmg` and `*.exe` through LFS, which is
  268.6 MB of preserved installers.
- **A build inside a slot does not write the main tree's `.build/` and
  `dist/`.** `repoRoot` is derived from the script's own location, so each slot
  has its own. The build prohibition still stands, for the disk cost and because
  the main tree's build is the one other agents depend on — but the corruption
  mechanism in the original warning does not apply, and the real shared write
  path is `node_modules`, listed above.