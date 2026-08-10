import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const init = vi.fn()

vi.mock('@sentry/node', () => ({ init }))
// The developer's own `.env` must not decide what this suite tests. `dotenv/config` is a side-effect
// import that would load a real `DSN` on any machine that has one, and dotenv never overwrites a key
// already present — so stubbing the module out is what keeps `DSN` under `vi.stubEnv`'s control.
vi.mock('dotenv/config', () => ({}))

const DSN = 'https://public@collector.example/1'

/**
 * `Sentry.init` runs at import time, so each case needs a clean ESM registry *and* a `DSN` chosen
 * before the module is evaluated. `vi.resetModules()` gives the first, `vi.stubEnv` the second.
 */
const importInstrument = async (dsn: string) => {
	vi.stubEnv('DSN', dsn)
	await import('../src/instrument.mts')
}

describe('instrument', () => {
	beforeEach(() => {
		vi.resetModules()
		init.mockClear()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('hands Sentry the DSN and nothing else — no transport of its own', async () => {
		await importInstrument(DSN)

		// Exact-argument, not a subset match: a transport option added back later has to fail here.
		expect(init).toHaveBeenCalledExactlyOnceWith({ dsn: DSN })
		expect(Object.keys(init.mock.calls[0][0] as object)).toStrictEqual(['dsn'])
	})

	it('does not initialise at all when DSN is empty', async () => {
		await importInstrument('')

		expect(init).not.toHaveBeenCalled()
	})
})
