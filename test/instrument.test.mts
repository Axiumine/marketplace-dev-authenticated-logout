import type { sentryBeforeSend } from '@axiumine/marketplace-common/others/sentryBeforeSend'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const init = vi.fn()

vi.mock('@sentry/node', () => ({ init }))
// The developer's own `.env` must not decide what this suite tests. `dotenv/config` is a side-effect
// import that would load a real `DSN` on any machine that has one, and dotenv never overwrites a key
// already present — so stubbing the module out is what keeps `DSN` under `vi.stubEnv`'s control.
vi.mock('dotenv/config', () => ({}))

const DSN = 'https://public@collector.example/1'

/**
 * Every `dataCollection` category, written out here rather than imported from the module under test.
 * Supplying the option at all flips the SDK's base from the restrictive legacy mapping to the fully
 * permissive `DEFAULTS`, so a category missing from the init object is a category switched **on** —
 * which is what makes an exhaustive, exact-match expectation the only one worth asserting.
 */
const EXPECTED_DATA_COLLECTION = {
	userInfo: false,
	cookies: false,
	httpHeaders: { request: false, response: false },
	httpBodies: [],
	urlQueryParams: false,
	graphQL: { document: true, variables: false },
	genAI: { inputs: false, outputs: false },
	databaseQueryData: false,
	stackFrameVariables: false,
	frameContextLines: 7
}

/**
 * `Sentry.init` runs at import time, so each case needs a clean ESM registry *and* a `DSN` chosen
 * before the module is evaluated. `vi.resetModules()` gives the first, `vi.stubEnv` the second.
 */
const importInstrument = async (dsn: string) => {
	vi.stubEnv('DSN', dsn)
	await import('../src/instrument.mts')
}

/**
 * The shared scrubber, read from the *same* module-registry generation the service just imported.
 * A top-level `import` would survive `vi.resetModules()` and hand back a different instance of the
 * same file, so an identity check against it fails on two functions that really are the one function.
 */
const importScrubber = async (): Promise<typeof sentryBeforeSend> =>
	(await import('@axiumine/marketplace-common/others/sentryBeforeSend')).sentryBeforeSend

/** The options object the module really handed the SDK — read back, never assumed from the literal. */
const initOptions = () => init.mock.calls[0][0] as Record<string, unknown>

describe('instrument', () => {
	beforeEach(() => {
		vi.resetModules()
		init.mockClear()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('hands Sentry the DSN, the collection policy and the scrubber — nothing else', async () => {
		await importInstrument(DSN)

		// Exact-argument, not a subset match: a transport option added back later has to fail here.
		expect(init).toHaveBeenCalledExactlyOnceWith({
			dsn: DSN,
			dataCollection: EXPECTED_DATA_COLLECTION,
			beforeSend: await importScrubber()
		})
		expect(Object.keys(initOptions())).toStrictEqual(['dsn', 'dataCollection', 'beforeSend'])
	})

	it('carries no sendDefaultPii key at all — absent, not false', async () => {
		await importInstrument(DSN)

		expect(initOptions()).not.toHaveProperty('sendDefaultPii')
	})

	it('re-enables none of the categories that would carry passwords or decrypted fields', async () => {
		await importInstrument(DSN)

		const dataCollection = initOptions().dataCollection as Record<string, unknown>

		expect(dataCollection.httpBodies).toStrictEqual([])
		expect(dataCollection.databaseQueryData).toBe(false)
		expect(dataCollection.stackFrameVariables).toBe(false)
		expect(dataCollection.userInfo).toBe(false)
		expect(dataCollection.graphQL).toStrictEqual({ document: true, variables: false })
	})

	it('wires the shared scrubber as beforeSend, and what is wired really scrubs', async () => {
		await importInstrument(DSN)

		const beforeSend = initOptions().beforeSend as typeof sentryBeforeSend
		const scrubber = await importScrubber()
		const event = {
			contexts: { trace: { data: { 'http.client_ip': '203.0.113.47', 'http.method': 'POST' } } },
			request: { headers: { authorization: 'Bearer 9f2c1b7e', 'user-agent': 'itest-agent/1.0' } }
		}

		expect(beforeSend).toBe(scrubber)
		expect(beforeSend(event)).toStrictEqual({
			contexts: { trace: { data: { 'http.method': 'POST' } } },
			request: { headers: { 'user-agent': 'itest-agent/1.0' } }
		})
	})

	it('does not initialise at all when DSN is empty', async () => {
		await importInstrument('')

		expect(init).not.toHaveBeenCalled()
	})
})
