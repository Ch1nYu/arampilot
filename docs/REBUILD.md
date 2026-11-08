# Rebuilding this project as a clean public repository

## Why a fresh repo

The development history of this project contains private session notes
(Riot IDs, account identifiers, local paths, machine-specific details, and
per-player ranking data). History cannot be un-published once it is public,
so the public repository starts from a single clean snapshot built from the
current working tree — the old repository stays local as an archive and is
never pushed.

## Pre-push go/no-go checklist

Run these before the first commit lands in the new repo; every item must
pass.

1. **Identity scrub** — search the working tree for Riot game names,
   account identifiers (`puuid`s), user names, home-directory paths, process
   IDs, port numbers, and session timestamps. Expected result: zero matches.
2. **Gameplay data scrub** — any embedded example rankings or seeds (for
   example in `mockups/algo-lab.html`) must use neutral fixture data, not a
   real player's history.
3. **Secrets** — no tokens, no `.env`, no LCU lockfiles, no credentials
   anywhere in the tree. Runtime config lives outside the repo
   (`%APPDATA%` on Windows) and is never committed.
4. **Ignored artifacts** — confirm `.gitignore` covers `node_modules`,
   `dist`, `src-tauri/target`, lab working JSON, and `__pycache__`; confirm
   with `git ls-files` that only source, config, and docs are tracked.
5. **Build check** — in the new repo, `cargo test --manifest-path
   src-tauri/Cargo.toml --lib` passes and `pnpm tsc --noEmit && pnpm build`
   succeeds from a clean checkout.

## Setup steps

1. Create an empty repository on GitHub (no README, no license, no gitignore
   — the repo provides its own).
2. Copy the working tree into a new folder, excluding the old `.git/`.
3. `git init`, add files, and make the initial commit, for example:
   `chore: initial public snapshot`.
4. Add the `origin` remote and push the initial commit.

## Standing rules for the public repository

- **No personal information, ever.** No Riot IDs, account identifiers,
  local user paths, PIDs, ports, session logs, or per-account config data —
  in code, comments, docs, screenshots, or commit messages. Runtime data
  belongs outside the repo.
- **Minimal-change commits.** One concern per commit. Do not mix
  refactoring with features, or docs with behavior changes. Keep each diff
  reviewable on its own.
- **Commit messages describe the change, not the process.** Use Conventional
  Commits (`feat:` / `fix:` / `docs:` / `chore:`). The message states what
  the code now does; it never records who wrote it, why a cleanup happened,
  or anything specific to one machine or session.
- **Generated output stays out.** `dist/`, `node_modules/`, `target/`, and
  lab working files are never tracked.

## Verification before the first push

- `git log --all` shows the single initial commit and nothing else.
- A full-text search of the tree for the identifiers from step 1 of the
  checklist returns zero matches.
- `git ls-files` contains no runtime data, secrets, or build output.
