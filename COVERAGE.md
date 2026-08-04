# Test quality policy — 100% coverage **and** 100% mutation score, no exceptions

This service requires **100% test coverage on every metric** — statements, branches,
functions, and lines — **and a 100% Stryker mutation score**. Both are hard gates, not targets.

They answer different questions, which is why both exist:

| Gate | Question it answers |
|---|---|
| coverage | did a test *execute* this line? |
| mutation | would a test *fail* if this line were wrong? |

100% coverage with weak assertions is the normal failure mode, and it is invisible to the
coverage number. Mutation testing is what falsifies it: Stryker rewrites `src/` one small
change at a time (`true` → `false`, a string → `""`, a block → `{}`) and re-runs the suite.
A mutant that *survives* is an edit no test noticed.

## The rule

If coverage is below 100% on any metric, the fix is one of:

1. **Add the missing tests** for the uncovered lines / branches / functions.
2. **Delete the code** if it is unreachable or dead.

If the mutation score is below 100%, the fix is one of:

1. **Strengthen the assertion** that should have caught the mutant.
2. **Delete the code** if the mutant proves the branch is dead.
3. **Document an equivalent mutant** with `// Stryker disable next-line <Mutator>: <why>` —
   only when the mutated code provably cannot behave differently on any reachable input.

**Never** lower a threshold to make a run pass. The thresholds are the specification;
red means the work is not done, not that the number is wrong.

## Where it is enforced

| Layer | File | What it does |
|---|---|---|
| Local test run | `vitest.config.mts` → `test.coverage.thresholds` | `yarn test:cov` exits non-zero if any metric < 100% |
| Local mutation run | `stryker.config.mjs` → `thresholds.break` | `yarn test:mutation` exits non-zero if the score < 100 |
| Qodana scan gate | `qodana.yaml` → `failureConditions.testCoverageThresholds` (`total`/`fresh` = 100) | `./qodana.sh` fails the scan if coverage < 100% |
| Git `pre-commit` | `.githooks/pre-commit` | blocks the commit if `yarn test:cov` **or** the Qodana scan fails |
| Git `pre-push` | `.githooks/pre-push` | blocks the push if `yarn lint:check`, `yarn test:cov`, `yarn test:mutation` **or** the Qodana scan fails |

The three coverage layers read the same coverage run (vitest, v8 provider, lcov →
`coverage/lcov.info`, `all: true` over `src/**/*.mts`). Change coverage config in
`vitest.config.mts` only. Qodana has no mutation gate — `pre-push` is the only one.

Both hooks run the scan on purpose. `git merge --no-ff` never fires `pre-commit` —
git runs that hook for `git commit` only — so the merge commit, the one revision
that reaches `origin`, is the single commit no pre-commit scan ever sees. And
Qodana Cloud files each report under the branch it ran on, so a repo scanned only
at commit time never produces a `main`-tagged report to baseline against. Each hook
hands `qodana.sh` `SKIP_TESTS=1`, reusing the `coverage/lcov.info` its own coverage
step just wrote rather than letting the script regenerate it with a test run whose
failure it swallows. `SKIP_QODANA=1` skips the scan alone; the coverage and
mutation gates stay.

## Two projects, one coverage report

`vitest.config.mts` defines two projects; `yarn test:cov` runs both and aggregates coverage:

| Project | Files | Redis | Purpose |
|---|---|---|---|
| `unit` | `test/*.test.mts` | mocked | pure logic, error paths, prod branches — fast, offline |
| `integration` | `test/integration/*.itest.mts` | **real cluster** | boots the server via `start()` and drives it over HTTP |

The integration project connects to the **live Redis cluster** using the `REDIS_*` values from
`.env` (loaded by the sources' own `dotenv.config()`). It overrides only the keyspace prefix
(`REDIS_KEY=marketplaceDev:itest:authenticatedLogout:`, this service's own namespace under the
ACL-allowed `marketplaceDev:itest:` stem) and `PORT=0` (ephemeral). Run just one side with
`yarn test:unit` / `yarn test:integration`.

Consequence: the coverage gate — and therefore `pre-push` and `./qodana.sh` — needs the Redis
cluster reachable. That is intentional: 100% here means the server was really booted and really
talked to Redis, not that a mock returned the expected value.

## Enabling the hook

The `pre-push` hook lives in `.githooks/` (tracked in git). It is activated by:

```bash
git config core.hooksPath .githooks
```

The `prepare` script in `package.json` runs this automatically on `yarn install`, so a
fresh clone is gated after the first install. To verify:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Server boot and Sentry init are covered — do not exclude them

`src/index.mts` (Koa/Apollo wiring, routing, shutdown) and `src/instrument.mts` (Sentry
init) reach 100% through the **integration** project, which boots the real server and hits
`/logout`, `/health`, and an unknown path over HTTP. They are **not** `v8 ignore`d and must
stay that way — the only `v8 ignore` block is the entrypoint tail of `index.mts` (the
`if (NODE_ENV !== 'test')` bootstrap that registers signal handlers and calls `start()`),
which cannot run under the test process without killing the worker via `process.exit`. Every
function it wires (`start`, `gracefulShutdown`, `onUnhandledRejection`, `onUncaughtException`)
is exercised directly by tests, so the ignored block contains only the wiring, no logic.

## Mutation testing — what is mutated, and what is not

`yarn test:mutation` runs Stryker (`stryker.config.mjs`) with the **vitest** runner over
`vitest.mutation.config.mts`. Two deliberate scope decisions, each of which would otherwise
show up as permanent survivors:

| Setting | Why |
|---|---|
| runs the **`unit` project only** | Stryker re-runs the suite once per mutant. Pointing that at `test/integration/*.itest.mts` would hit the real Redis cluster hundreds of times per mutant run, where `fileParallelism: false` serialises everything. Unit tests are Redis-mocked, so mutant runs stay hermetic and parallel. |
| `!src/index.mts`, `!src/instrument.mts`, `!src/graphQLApi/schema/types/**` | Server wiring and Sentry bootstrap are covered by the integration project, which this run does not execute; mutating them yields only `NoCoverage` noise. They stay gated by the 100% coverage requirement instead. |

`ignoreStatic` used to be a third entry here. It is **gone**, and the "unkillable" claim that
justified it was wrong. That flag drops every mutant in code that only runs at module load —
`name: 'MutationsApi'`, `name: 'QueriesApi'`, the `description` literals — and the diagnosis
behind it was an attribution artifact, not a real limitation: `test/logout.test.mts` and
`test/schema.test.mts` imported the module under test at file scope, so a mutant that made the
module throw during evaluation did so during Vitest's collection phase, before any test ran —
Stryker had nothing to attribute the failure to and reported the mutant Survived even though the
whole suite plainly failed. Turning that off surfaced 11 real static mutants.

Nine of those eleven were fixed by importing the module inside `beforeAll` instead of at the top
of the file — that moves the throw into a running test. The remaining two survivors
(`mutations.mts`'s `name: 'MutationsApi'` / whole-object wipe, `queries.mts`'s equivalents) needed
one more step: graphql-js's `assertName` throws the moment `new GraphQLObjectType(...)` runs, and
a **shared** `beforeAll` that throws makes Vitest mark every test in its scope "skipped", not
"failed" — Stryker only counts a failed test as a kill, so the throw was still unattributed. Those
two constructions are now imported fresh inside the one test that asserts their shape, so the
throw fails only that test. See the comments in `test/logout.test.mts` (`describe('MutationsApi')`)
and `test/schema.test.mts` (`describe('QueriesApi')`) for the mechanics.

Everything — the Koa auth middleware, the resolvers, the DB teardown, and now the module-load
GraphQL declarations — is fully mutated. Current state: **104 mutants, 104 killed, 0 survived**,
~35 s.

### Equivalent mutants

**Three** `// Stryker disable next-line` comments live in `src/`, and between them they suppress
**six** mutants — the two numbers are not the same, which is what an earlier revision of this section
got wrong by claiming four of each. One comment names two mutator types
(`ConditionalExpression,StringLiteral`) on a multi-line guard, and that one line alone accounts for
four of the six. Reconcile against the report, not against the comment count:
`grep -o '"status":"Ignored"' reports/mutation/mutation.html | wc -l`.

Current run: **110 instrumented · 104 killed · 6 ignored · 0 survived · score 100.00**. The score is
computed over the 104 tested mutants; ignored ones are excluded from the denominator, which is why
104/104 and 100.00 agree while 110 is the instrumented total.

Each comment carries its reachability argument:

- `authorizationLogoutHandler.mts` — the `?.` and the `typeof ctx.request.header !== 'undefined'`
  guard in the **authorization** block. Both exits of the cookie block above require
  `ctx.request.header` to be defined, so neither guard can ever fire. They are kept for symmetry
  with the cookie block, where the same guard is live.
- `mutations/logout.mts` — the `?.` in `ctx.state.user?.accessToken`. The `del` on the line above
  already dereferenced `ctx.state.user`, so an undefined user has thrown into the `catch` by then.

Do not add to this list without the same kind of argument. "I could not think of a test" is not
an equivalence proof.

### Writing tests that kill

The single biggest source of survivors here was `await expect(...).rejects.toThrow()`. Every wrong
path in the auth handler throws *something*, so that assertion passes for the original and for the
mutant alike. `expectRejectionDescription` in `test/authorizationLogoutHandler.test.mts` asserts
*which* precondition failed (the `description` extension set by `throwGraphQLError`) — that one
change killed 11 mutants.

## Running it

```bash
yarn test:cov       # coverage + threshold check (the source of truth)
yarn test:mutation  # Stryker; report at reports/mutation/mutation.html
./qodana.sh         # full Qodana Ultimate scan, incl. the 100% coverage gate
```

`git push` runs the first two, in that order, and blocks on either.
