# Publishing checklist

The `codex/clean` branch removes generated recovery material from its tree, but
its parent commit still contains that material. Do not push the branch and
assume the deleted files are absent from Git history.

Create a new repository from an archive of the clean commit:

```sh
git archive --format=tar codex/clean | tar -xf - -C /path/to/empty-export
cd /path/to/empty-export
git init
git add .
git commit -m "Initial reconstructed source import"
```

Before adding a public remote:

1. Run `npm run publication:check` on the committed clean branch. It performs
   the archive/init/add flow above and requires the new index to have the exact
   same Git tree.
2. Run `npm ci`, `npm run bootstrap`, `npm run check`, `npm run package`, and
   `npm run verify` from a fresh clone/export.
3. Confirm `git status --ignored` shows no generated payload selected for Git.
4. Scan the exported tree and full new history for credentials and absolute
   machine paths.
5. Review `NOTICE.md` and obtain an independent rights review. No upstream
   license is supplied by this repository.
6. Decide on a license only for material you have authority to license; do not
   imply that license covers the upstream application or trademarks.
