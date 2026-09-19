import { beforeEach } from 'vitest'

/**
 * The longest full name a test may carry, in characters.
 *
 * ⚠️ Not a style rule — a limit the mutation gate depends on. For each mutant, Stryker's vitest runner
 * reruns only the tests that cover it, and selects them with one `testNamePattern`: the full name of every
 * covering test, regex-escaped and joined with `|`. V8 refuses to compile a pattern that holds a literal
 * longer than 32,767 characters ("Regular expression too large"), so one oversized name kills every mutant
 * its test covers before a single test runs. Stryker records those mutants as RuntimeError — a status the
 * mutation score leaves out — and the gate still reads 100 with none of them tested.
 *
 * A name reaches that size one way: `it.each` / `describe.each` with `%s` (or `%o`, `%j`) formatting a
 * row element that is an object, which prints the whole object — functions, schemas and all — into the
 * name. marketplace-user's `test/routeOptions/category.test.tsx` once carried two 474 KB names made exactly
 * like that, and ten mutants went untested behind them. The fix is always the same: lead the row with a
 * short label and format that.
 *
 * 256 is far below V8's limit on purpose. No name written as a sentence comes near it — the longest on the
 * platform is under 200 — so a name past it is a formatted object, and failing here names the test while
 * it is still one line long, rather than weeks later as a dent in a mutation report nobody reads.
 */
const MAX_TEST_NAME_LENGTH = 256

beforeEach(({ task }) => {
	// Built exactly as Stryker builds it (`collectTestName` in @stryker-mutator/vitest-runner): every
	// enclosing suite, outermost first, then the test, joined with one space. That string is what goes into
	// the pattern, so that string is what is measured.
	const parts = [task.name]
	for (let suite = task.suite; suite !== undefined; suite = suite.suite) parts.unshift(suite.name)
	const name = parts.join(' ').trim()

	if (name.length > MAX_TEST_NAME_LENGTH) {
		throw new Error(
			`Test name is ${String(name.length)} characters; the cap is ${String(MAX_TEST_NAME_LENGTH)}. An \`.each\` row ` +
				'is probably formatting an object into it: lead the row with a short label and format that. Why the ' +
				`cap exists: vitest.testNames.mts. The name starts: ${name.slice(0, 160)}`
		)
	}
})
