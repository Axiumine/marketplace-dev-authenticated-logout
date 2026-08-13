# Repository mechanics

How this repo's git plumbing behaves, and why. Nothing here changes what you write — it explains what
happens when you commit, push, or watch a gate fail. [`CLAUDE.md`](./CLAUDE.md) carries the rules themselves.

## Hooks

`git push` runs `.githooks/pre-push`, a blocking **five**-step gate: `yarn semgrep:ci` (Semgrep SAST over the
sources, vendored rules, pinned image, `--network none`), then `yarn lint:check` (eslint, then
`prettier --check`, both over the whole tree), then `yarn test:cov` (100% on every metric), then
`yarn test:mutation` (Stryker, `thresholds.break: 100`), then Qodana (`./qodana.sh`, gated by
`qodana.yaml`: coverage 100 total / 100 fresh, the SCA vulnerable-dependency check and the license
audit). Keep the hook executable: git skips a non-executable hook with only a hint, so the gate
disappears without ever failing.

`git commit` runs `.githooks/pre-commit`, which is the secret guard *and* three of those five — lint,
coverage, Qodana. Semgrep and mutation are pre-push only.

Semgrep is first because it is the cheapest of the five by an order of magnitude — about three seconds
against the minutes the rest take together, so a rule violation is reported before anything slow runs.
Lint leads the four that follow because it is the cheapest of them and the only one that can fail on a
file the others are perfectly happy with — the next `yarn lint` would rewrite it anyway. It was
ungated for a long time, and so were `eslint.config.js`, `.prettierrc` and `.prettierignore`: none of
the three was in the hook's `RELEVANT_PATHS`, so a commit touching only them skipped every gate there
is. All three are in the filter now.

## Why Qodana runs in both hooks

**`git merge --no-ff` never fires `pre-commit`** — git runs that hook for `git commit` only — so in the
branch → commit → merge → push flow the merge commit, the one revision that actually reaches origin,
is the single commit no pre-commit scan ever sees. Two individually clean branches can merge into a
tree that is not.

The second reason is Qodana Cloud. It files every report under the branch it was produced on, and
pre-commit always runs on the feature branch *before* the commit exists — so a repo gated only there
can never produce a `main`-tagged report, `main` is not offered as the project's default branch, and
the "new problems" baseline has nothing stable to compare against. pre-push runs after the merge, on
main, which is the revision the baseline wants. Both scans hand `qodana.sh` `SKIP_TESTS=1` so the
coverage report the preceding gate just wrote is reused rather than regenerated with its exit code
swallowed.

## Node selection

Ahead of every gate the hook selects node, reading `engines.node` from `package.json` and switching via
nvm. The gates shell out to yarn and yarn's `engines` check is a hard exit 1, so without it a push from
a shell on the machine default node dies *before* the first gate, under that gate's banner — which is
how a node mismatch first read as a type error. Every repo's `pre-push` carries that block, and so does
every `pre-commit`, since all of them run tests.

## Bypasses

`SKIP_QODANA=1` (scan only — coverage and mutation still gate) · `git commit --no-verify` /
`git push --no-verify` (the whole hook). Both are gate removals. See [`CLAUDE.md`](./CLAUDE.md) for when they may be
used, which is: when the user says so, and not otherwise.
