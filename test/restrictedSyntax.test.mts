import { readdir, readFile } from 'node:fs/promises'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/*
 * The `no-restricted-syntax` block in `eslint.config.js`, proved one selector at a time.
 *
 * A rule nobody exercises is a comment. Each fixture below is the *exact* shape the rule exists to
 * refuse — including the assignment form the audit actually found, which a `Property`-only selector
 * would have let through — and the last one is the compliant shape, which must stay silent.
 *
 * The fixtures are `.mts.fixture` rather than `.mts` on purpose: a real `.mts` under `test/` would be
 * linted by `yarn lint` and report the very findings it is here to contain, and adding it to `ignores`
 * would then hide it from this suite too. They are read as text and linted through `lintText` at a
 * `test/`-shaped path, which is the config this block applies to along with every other file.
 */

const FIXTURES = new URL('./fixtures/restrictedSyntax/', import.meta.url)

const TLS_MESSAGE = 'certificate verification stays on.'
const PII_MESSAGE = 'the blanket Sentry PII flag is absent by decision, not set to false.'
const BODY_MESSAGE = 'the request body is never captured.'
const HOOKS_MESSAGE = '`beforeSend` and `beforeSendTransaction` are wired together or not at all.'
const KEYGRIP_MESSAGE = 'KEYGRIP_KEY_1/KEYGRIP_KEY_2 are gone since ADR-034.'

/*
 * The path matters as much as the code: the keygrip ban is scoped to `src/**`, so the same
 * fixture text is a finding at one path and silent at the other. Both are linted here — a fixture that
 * only ever ran at a test path could not tell a correctly scoped rule from one that stopped firing.
 *
 * ⚠️ `SRC_PATH` is an existing source file, not the invented name `TEST_PATH` is. The shared config's
 * TypeScript block carries `parserOptions.project`, and a path under `src/` that no file occupies is not
 * in the TS program — the parser then fails the whole lint with a fatal error and reports no rule messages
 * at all, which reads exactly like a rule that stopped firing. The content linted is the fixture's; only
 * the path is borrowed. If that file ever moves, point this at another src file.
 */
const SRC_PATH = 'src/lib/db/disconnectAllDatabases.mts'
const TEST_PATH = 'test/restrictedSyntaxFixture.mts'

const lintFixture = async (name: string, filePath: string = TEST_PATH) => {
	const code = await readFile(new URL(`${name}.mts.fixture`, FIXTURES), 'utf8')
	const [result] = await new ESLint().lintText(code, { filePath })

	return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax')
}

describe('the no-restricted-syntax block fires on every shape it names', () => {
	it.each([
		['assignment-reject-unauthorized', TLS_MESSAGE],
		['property-reject-unauthorized', TLS_MESSAGE],
		['computed-property-reject-unauthorized', TLS_MESSAGE],
		['send-default-pii', PII_MESSAGE],
		['member-node-tls-reject-unauthorized', TLS_MESSAGE],
		['literal-node-tls-reject-unauthorized', TLS_MESSAGE],
		['max-incoming-request-body-size', BODY_MESSAGE],
		['before-send-without-transaction', HOOKS_MESSAGE]
	])('reports %s exactly once', async (fixture, expected) => {
		const messages = await lintFixture(fixture)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(expected)
		expect(messages[0]?.severity).toBe(2)
	})
})

/*
 * `KEYGRIP_KEY_1`/`KEYGRIP_KEY_2` stopped being read when ADR-034 moved the signing keys into a wrapped
 * Redis record. Reading one here again would sign cookies the other four services cannot verify, and the
 * only symptom is a browser that is silently logged out — so the names are refused rather than merely
 * absent. Two selectors: `process.env.X` parses as an Identifier, `process.env['X']` as a Literal.
 *
 * Scoped to `src/**` because `index.unit.test.mts` asserts those very names are NOT in
 * `REQUIRED_ENV_VARS`. A repo-wide ban would refuse the test that proves the story.
 */
describe('the KEYGRIP_KEY_ ban is scoped to src/**', () => {
	it.each(['keygrip-key-member', 'keygrip-key-literal'])('reports %s exactly once under src/', async (fixture) => {
		const messages = await lintFixture(fixture, SRC_PATH)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(KEYGRIP_MESSAGE)
		expect(messages[0]?.severity).toBe(2)
	})

	it.each(['keygrip-key-member', 'keygrip-key-literal'])('stays silent on %s under test/', async (fixture) => {
		expect(await lintFixture(fixture)).toStrictEqual([])
	})

	// The negative half: both selectors are anchored on `process.env`, so the KEK the services really do
	// read is untouched, and so is the `KEYGRIP_KEY_BYTES` constant a prefix match on the bare name would
	// have caught.
	it.each([SRC_PATH, TEST_PATH])('reports nothing on the compliant KEK read at %s', async (filePath) => {
		expect(await lintFixture('keygrip-kek-compliant', filePath)).toStrictEqual([])
	})

	// ⚠️ The src-scoped config object sets `no-restricted-syntax` a second time, and a later flat-config
	// object naming the same rule discards the earlier options outright rather than merging them. Drop the
	// spread that carries the shared entries into it and every selector above silently stops firing inside
	// src/** — the half of the codebase they exist for. This comparison needs no fixture per entry, so it
	// cannot go stale as entries are added.
	it('gives src/** every entry test/ has, plus the two keygrip selectors and nothing else', async () => {
		const entriesAt = async (filePath: string) => {
			const config = await new ESLint().calculateConfigForFile(filePath)
			const [, ...entries] = config.rules['no-restricted-syntax'] as [number, ...Record<string, string>[]]

			return entries
		}

		const shared = await entriesAt(TEST_PATH)

		expect(await entriesAt(SRC_PATH)).toStrictEqual([
			...shared,
			{
				selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^KEYGRIP_KEY_/]",
				message: expect.stringContaining(KEYGRIP_MESSAGE) as unknown as string
			},
			{
				selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.value=/^KEYGRIP_KEY_/]",
				message: expect.stringContaining(KEYGRIP_MESSAGE) as unknown as string
			}
		])
		expect(shared.some((entry) => entry.selector.includes('KEYGRIP_KEY_'))).toBe(false)
	})
})

describe('the block stays silent on the shape the services carry', () => {
	it('reports nothing on the compliant init options', async () => {
		expect(await lintFixture('compliant')).toStrictEqual([])
	})

	// Every shared selector still fires at a src path, which is the same guarantee the structural
	// comparison above makes, driven through the linter rather than through the config object.
	it.each([
		['send-default-pii', PII_MESSAGE],
		['assignment-reject-unauthorized', TLS_MESSAGE]
	])('still reports %s under src/, so the shared entries survived the second config object', async (fixture, expected) => {
		const messages = await lintFixture(fixture, SRC_PATH)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(expected)
	})
})

const ITEM_CATEGORY_MESSAGE = 'ADR-012: `itemCategory` is written by marketplace-dev-admin-authenticated-resource'
const ITEM_CATEGORY_ALIAS_MESSAGE = 'ADR-012: import the itemCategory model under its own name.'

/*
 * ADR-012, and RISK_REGISTER R19.
 *
 * The category tree is capped at two levels by a resolver rather than by the collection's `$jsonSchema`,
 * because a validator cannot read the parent document to learn how deep the one in front of it sits. The
 * cap therefore holds for exactly as long as every write to `itemCategory` goes through the Admin tier's
 * four functions, and until this block existed nothing structural said so.
 *
 * Three shapes, because two of them are the same write spelled differently and the third renames the
 * model out of the first two's reach: `ItemCategory.updateOne(...)`, `ItemCategory['updateOne'](...)`,
 * and `import { ItemCategory as Categories }`. The fourth case is the one that must stay silent — a
 * count, which is what this tier actually does with the collection.
 */
describe('the itemCategory write ban fires on every shape it names', () => {
	it.each([
		['item-category-write-call', ITEM_CATEGORY_MESSAGE],
		['item-category-write-computed', ITEM_CATEGORY_MESSAGE],
		['item-category-write-alias', ITEM_CATEGORY_ALIAS_MESSAGE]
	])('reports %s exactly once', async (fixture, expected) => {
		const messages = await lintFixture(fixture)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(expected)
		expect(messages[0]?.severity).toBe(2)
	})

	it('reports nothing on a read, which is all this tier does with the collection', async () => {
		expect(await lintFixture('item-category-compliant')).toStrictEqual([])
	})
})

const REDIS_DEL_MESSAGE = 'BCON-08: one Redis key per `del`.'

/*
 * BCON-08 and NFR-SC03, and RISK_REGISTER R32.
 *
 * Redis is a cluster here, and a multi-key `DEL` across two slots is a runtime `CROSSSLOT` error rather
 * than a slow path. The convention that answers it — one key per call, batched with `Promise.all` — was
 * prose in three documents and checked by nothing, while `@redis/client` types the batched form as legal:
 * a violation compiles, passes review as ordinary Redis code, and fails in production on the path that
 * revokes a session.
 *
 * Three fixtures, because the batch is spelled three ways and a rule that names one lets the other two
 * through. The fourth is the shape this repo already carries and must stay silent — a rule that also
 * refused the compliant form would be reverted within a day, which is the failure mode a one-directional
 * test never catches.
 */
describe('the one-key-per-del rule fires on every batched shape', () => {
	it.each([
		['redis-del-two-arguments', REDIS_DEL_MESSAGE],
		['redis-del-array-argument', REDIS_DEL_MESSAGE],
		['redis-del-spread-argument', REDIS_DEL_MESSAGE]
	])('reports %s exactly once', async (fixture, expected) => {
		const messages = await lintFixture(fixture)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(expected)
		expect(messages[0]?.severity).toBe(2)
	})

	it('reports nothing on the per-key shape the session code carries', async () => {
		expect(await lintFixture('redis-del-compliant')).toStrictEqual([])
	})
})

const SEED_MESSAGE = 'An integration test seeds through the raw driver'

/*
 * RISK_REGISTER R33, and docs/testing.md "Integration test conventions".
 *
 * The convention — seed through the driver, never through a model — was prose, and prose is checked by
 * nobody. `no-restricted-imports` checks it now, and the three cases below are the three things that
 * have to be true at once: it fires inside `test/integration/**`, it stays out of the way of the unit
 * tests one directory up, which mock these very models by name, and it says nothing about the raw-driver
 * seed the harnesses already use. A rule proved only in the first direction is a rule that could be
 * scoped to every file on the platform and still look correct from here.
 *
 * Both paths are invented names rather than real files, which is safe for this rule and not for every
 * one: `no-restricted-imports` reads the import declaration alone, so no TypeScript program has to
 * contain the path the way `SRC_PATH` above must.
 */
const ITEST_PATH = 'test/integration/restrictedImportsFixture.itest.mts'
const UNIT_TEST_PATH = 'test/restrictedImportsFixture.mts'

const lintImports = async (name: string, filePath: string) => {
	const code = await readFile(new URL(`${name}.mts.fixture`, FIXTURES), 'utf8')
	const [result] = await new ESLint().lintText(code, { filePath })

	return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-imports')
}

describe('an integration test may not seed through a Mongoose model', () => {
	it('reports the model import exactly once under test/integration/', async () => {
		const messages = await lintImports('integration-seed-via-model', ITEST_PATH)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(SEED_MESSAGE)
		expect(messages[0]?.severity).toBe(2)
	})

	it('stays silent on the same import in a unit test, which mocks the model by name', async () => {
		expect(await lintImports('integration-seed-via-model', UNIT_TEST_PATH)).toStrictEqual([])
	})

	it('stays silent on the raw-driver seed every harness here already carries', async () => {
		expect(await lintImports('integration-seed-via-raw-driver', ITEST_PATH)).toStrictEqual([])
	})
})

const SRC = new URL('../src/', import.meta.url)

/** An inline suppression is one comment, and it switches off every selector this file proves. */
export const suppressesTheBlock = (code: string): boolean => code.includes('eslint-disable')

/** Every `.mts` under `src/` carrying one, path relative to `src/`. */
async function sourcesSuppressingTheBlock(directory = ''): Promise<string[]> {
	const entries = await readdir(new URL(directory, SRC), { withFileTypes: true })
	const found: string[] = []

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) found.push(...(await sourcesSuppressingTheBlock(`${directory}${entry.name}/`)))
		else if (entry.name.endsWith('.mts')) {
			if (suppressesTheBlock(await readFile(new URL(`${directory}${entry.name}`, SRC), 'utf8'))) {
				found.push(`${directory}${entry.name}`)
			}
		}
	}

	return found
}

/*
 * The backstop, without which every selector above is one comment wide.
 *
 * `no-restricted-syntax` is a lint rule, and a lint rule is switched off from inside the file it
 * governs: one `// eslint-disable-next-line` and the ban that took a config block, a fixture and a test
 * to state is gone, silently, in a diff that reads as housekeeping. No source file on this platform
 * carries such a comment today — measured, not assumed — so the rule this asserts is the one already
 * true: none of them may. A file that needs one is a decision worth a reviewer, which is what failing
 * here buys.
 *
 * Any `eslint-disable`, not only one naming this rule: a bare `/* eslint-disable *\/` switches off
 * everything, and a rule list is a list somebody can extend after the fact.
 */
describe('nothing under src/ switches the block off inline', () => {
	it('carries no eslint-disable comment at all', async () => {
		expect(await sourcesSuppressingTheBlock()).toStrictEqual([])
	})

	it('would notice one, in either spelling', () => {
		expect(suppressesTheBlock('// eslint-disable-next-line no-restricted-syntax')).toBe(true)
		expect(suppressesTheBlock('/* eslint-disable */')).toBe(true)
		expect(suppressesTheBlock('const disabled = false')).toBe(false)
	})
})
