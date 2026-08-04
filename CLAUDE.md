# marketplace-dev-authenticated-logout

One of the seven backend services. **Read the parent workspace's `CLAUDE.md` first** —
`/media/nvme/websites/fullstack-marketplace-blueprint/CLAUDE.md`. The tier/concern split, the port table, the terminology
mapping and the auth model live there, not here; this file carries only what is specific to this repo.

## Version control

**git**, branch `main`, remote `origin` on GitHub under `Marketplace-Org`, private. **Never commit on
`main`** — branch first (`git switch -c <type>/<slug>`), and merging is the user's decision alone.

**Delete the local branch as soon as it is merged**: `git branch -d <slug>`, in the same breath as the
merge, not at the top of the next task. Use `-d` and never `-D` — `-d` refuses a branch whose commits
are not already reachable from where you stand, so the safe case succeeds quietly and the unsafe one
stops you before the work is unreachable. Merges land locally here and are pushed as `main`, so no
forge-side "delete branch on merge" ever fires; a merged branch stays until someone removes it, and
`git branch` is the only place in-flight work is visible in a polyrepo this size. If the branch was
pushed too, `git push origin --delete <slug>`, and only if that push was asked for in the first place.

`git push` runs `.githooks/pre-push`, a blocking **four**-step gate: `yarn lint:check` (eslint, then
`prettier --check`, both over the whole tree), then `yarn test:cov` (100% on every metric), then
`yarn test:mutation` (Stryker, `thresholds.break: 100`), then Qodana (`./qodana.sh`, gated by
`qodana.yaml`: coverage 100 total / 100 fresh, the SCA vulnerable-dependency check and the license
audit). **Never lower a threshold** to get a push through — add the missing test. Keep the hook
executable: git skips a non-executable hook with only a hint, so the gate disappears without ever
failing.

Lint is first because it is the cheapest and because it is the only one of the four that can fail on a
file the others are perfectly happy with — the next `yarn lint` would rewrite it anyway. It was
ungated for a long time, and so were `eslint.config.js`, `.prettierrc` and `.prettierignore`: none of
the three was in the hook's `RELEVANT_PATHS`, so a commit touching only them skipped every gate there
is. All three are in the filter now.

`git commit` runs `.githooks/pre-commit`, which is the secret guard *and* three of those four — lint,
coverage, Qodana. Mutation is pre-push only. Both hooks scan on purpose, and the pre-push one is not
redundant: **`git merge --no-ff` never fires `pre-commit`** — git runs that hook for `git commit`
only — so in the branch → commit → merge → push flow the merge commit, the one revision that actually
reaches origin, is the single commit no pre-commit scan ever sees. Two individually clean branches can
merge into a tree that is not.

The second reason is Qodana Cloud. It files every report under the branch it was produced on, and
pre-commit always runs on the feature branch *before* the commit exists — so a repo gated only there
can never produce a `main`-tagged report, `main` is not offered as the project's default branch, and
the "new problems" baseline has nothing stable to compare against. pre-push runs after the merge, on
main, which is the revision the baseline wants. Both scans hand `qodana.sh` `SKIP_TESTS=1` so the
coverage report the preceding gate just wrote is reused rather than regenerated with its exit code
swallowed.

Ahead of every gate the hook selects node, reading `engines.node` from `package.json` and switching via
nvm. The gates shell out to yarn and yarn's `engines` check is a hard exit 1, so without it a push from
a shell on the machine default node dies *before* the first gate, under that gate's banner — which is
how a node mismatch first read as a type error. Every repo's `pre-push` carries that block, and so now
does every `pre-commit`, since all of them run tests.

Bypasses, in order of bluntness: `SKIP_QODANA=1` (scan only, coverage and mutation still gate) ·
`git commit --no-verify` / `git push --no-verify` (the whole hook).

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **marketplace-dev-authenticated-logout**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/marketplace-dev-authenticated-logout/context` | Codebase overview, check index freshness |
| `gitnexus://repo/marketplace-dev-authenticated-logout/clusters` | All functional areas |
| `gitnexus://repo/marketplace-dev-authenticated-logout/processes` | All execution flows |
| `gitnexus://repo/marketplace-dev-authenticated-logout/process/{name}` | Step-by-step execution trace |

## Cross-Repo Groups

This repository is listed under GitNexus **group(s): marketplace-platform** (see `~/.gitnexus/groups/`). For cross-repo analysis, use MCP tools `impact`, `query`, and `context` with `repo` set to `@<groupName>` or `@<groupName>/<memberPath>` (paths match keys in that group’s `group.yaml`). Use `group_list` / `group_sync` for membership and sync. From the project root: `node .gitnexus/run.cjs group list`, `node .gitnexus/run.cjs group sync <name>`, `node .gitnexus/run.cjs group impact <name> --target <symbol> --repo <group-path>` (the `.gitnexus/run.cjs` path is repo-root-relative).

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
