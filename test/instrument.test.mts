import type { sentryBeforeSend } from '@axiumine/marketplace-common/others/sentryBeforeSend'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const init = vi.fn()
/*
 * Mocked with a real shape rather than a bare `vi.fn()`: the module under test now *calls*
 * `httpIntegration` while building the options, and what it returns lands in `integrations`. Returning
 * the SDK's own `{ name: 'Http' }` is what lets the assertion below read the option back the way the SDK
 * would — the name is what makes a user instance replace the default one.
 */
const httpIntegration = vi.fn((options: unknown) => ({ name: 'Http', options }))

vi.mock('@sentry/node', () => ({ init, httpIntegration }))
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
const importWith = async (dsn: string, nodeEnv: string | undefined) => {
	vi.stubEnv('DSN', dsn)
	vi.stubEnv('NODE_ENV', nodeEnv)
	await import('../src/instrument.mts')
}

const importInstrument = async (dsn: string) => importWith(dsn, 'development')

/**
 * The unset case gets its own door rather than a defaulted parameter: passing `undefined` explicitly
 * *re-triggers* a default value, so `importInstrument(DSN, undefined)` would have stubbed `development`
 * and asserted the fallback against the one input that cannot reach it.
 */
const importInstrumentWithoutNodeEnv = async (dsn: string) => importWith(dsn, undefined)

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
		httpIntegration.mockClear()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('hands Sentry the DSN, the environment, the body gate, the collection policy and both hooks — nothing else', async () => {
		await importInstrument(DSN)

		// Exact-argument, not a subset match: a transport option added back later has to fail here.
		expect(init).toHaveBeenCalledExactlyOnceWith({
			dsn: DSN,
			environment: 'development',
			integrations: [{ name: 'Http', options: { maxIncomingRequestBodySize: 'none' } }],
			dataCollection: EXPECTED_DATA_COLLECTION,
			beforeSend: await importScrubber(),
			beforeSendTransaction: await importScrubber()
		})
		expect(Object.keys(initOptions())).toStrictEqual([
			'dsn',
			'environment',
			'integrations',
			'dataCollection',
			'beforeSend',
			'beforeSendTransaction'
		])
	})

	// 🔴 The measured defect: `dataCollection.httpBodies: []` gates the span attribute only, so
	// the raw GraphQL envelope — password in the document and in `variables` — reached `event.request.data`
	// on the shipped configuration. `'none'` is the value that stops the bytes being captured at all.
	it('switches the incoming request body off at the only gate that reaches it', async () => {
		await importInstrument(DSN)

		expect(httpIntegration).toHaveBeenCalledExactlyOnceWith({ maxIncomingRequestBodySize: 'none' })
		expect(initOptions().integrations).toStrictEqual([{ name: 'Http', options: { maxIncomingRequestBodySize: 'none' } }])
	})

	// The defect is an *absent* option resolving to a plausible default — the captured event read
	// "production" from a service that had just logged "for development" — so the test names the option.
	it('labels the events with the environment the process is running as', async () => {
		await importInstrument(DSN)

		expect(initOptions().environment).toBe('development')
	})

	it('never lets an unset NODE_ENV read as production, the way the SDK default does', async () => {
		await importInstrumentWithoutNodeEnv(DSN)

		expect(initOptions().environment).toBe('unknown')
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

	// Both hooks, and the same function in both: the SDK routes transaction events to
	// `beforeSendTransaction` alone, and the four network-derived attributes are on the transaction.
	it.each(['beforeSend', 'beforeSendTransaction'])(
		'wires the shared scrubber as %s, and what is wired really scrubs',
		async (hook) => {
			await importInstrument(DSN)

			const configured = initOptions()[hook] as typeof sentryBeforeSend
			const scrubber = await importScrubber()
			const event = {
				contexts: { trace: { data: { 'http.client_ip': '198.51.100.42', 'http.method': 'POST' } } },
				request: { data: '{"variables":{"password":"sentinel"}}', headers: { authorization: 'Bearer 9f2c1b7e' } }
			}

			expect(configured).toBe(scrubber)
			expect(configured(event)).toStrictEqual({
				contexts: { trace: { data: { 'http.method': 'POST' } } },
				request: { headers: {} }
			})
		}
	)

	it('does not initialise at all when DSN is empty', async () => {
		await importInstrument('')

		expect(init).not.toHaveBeenCalled()
	})
})
