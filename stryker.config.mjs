/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 110 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 34s
	 *   concurrency 28 → 34s
	 *
	 * Near enough to a tie, and kept anyway: at this size the run is all fixed cost — sandbox
	 * creation, vitest boot, the dry run — so the extra workers neither help nor hurt. Uniform across
	 * the platform beats a per-repo number that measures nothing.
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same 6 Ignored, the same files, lines and mutators — identical sets, not equal
	 * counts.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	// Mutation score is a push gate — see COVERAGE.md. `break` fails the run (exit 1)
	// below this score, which is what the pre-push hook keys off. Raise it as tests
	// improve; never lower it to make a run pass.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and `.stryker-tmp`
	 * — `ignorePatterns` itself defaults to empty, and `.qodana/` here runs to tens of megabytes.
	 *
	 * It is not only wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts',
		// Sentry bootstrap: a side-effect-only module imported via `node --import`.
		// Its options object is configuration, not logic — mutating DSN/sample rates
		// produces mutants no test can meaningfully kill.
		'!src/instrument.mts',
		// GraphQL type/schema declarations: literal SDL and field wiring, no branches.
		'!src/graphQLApi/schema/types/**',
		// Server wiring (listen, shutdown handlers, Apollo plugins). Its behaviour is
		// exercised by test/integration/*.itest.mts, which this run deliberately does
		// NOT execute — see the header of vitest.mutation.config.mts. Mutating it here
		// would only produce NoCoverage mutants: noise, not signal. index.mts stays
		// gated by the 100% line/branch coverage requirement instead.
		'!src/index.mts'
	]
}
