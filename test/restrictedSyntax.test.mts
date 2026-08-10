import { readFile } from 'node:fs/promises'

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

const TLS_MESSAGE = 'E12-S04: certificate verification stays on.'
const PII_MESSAGE = 'E12-S04: the blanket Sentry PII flag is absent by decision, not set to false.'

const lintFixture = async (name: string) => {
	const code = await readFile(new URL(`${name}.mts.fixture`, FIXTURES), 'utf8')
	const [result] = await new ESLint().lintText(code, { filePath: 'test/restrictedSyntaxFixture.mts' })

	return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax')
}

describe('the no-restricted-syntax block fires on every shape it names', () => {
	it.each([
		['assignment-reject-unauthorized', TLS_MESSAGE],
		['property-reject-unauthorized', TLS_MESSAGE],
		['computed-property-reject-unauthorized', TLS_MESSAGE],
		['send-default-pii', PII_MESSAGE],
		['member-node-tls-reject-unauthorized', TLS_MESSAGE],
		['literal-node-tls-reject-unauthorized', TLS_MESSAGE]
	])('reports %s exactly once', async (fixture, expected) => {
		const messages = await lintFixture(fixture)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(expected)
		expect(messages[0]?.severity).toBe(2)
	})
})

describe('the block stays silent on the shape the services carry', () => {
	it('reports nothing on the compliant init options', async () => {
		expect(await lintFixture('compliant')).toStrictEqual([])
	})
})
