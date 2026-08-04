import { describe, expect, it, vi } from 'vitest'

const init = vi.fn()
const httpsRequest = vi.fn(() => 'REQUEST' as unknown)

vi.mock('@sentry/node', () => ({ init }))
vi.mock('https', () => ({ request: httpsRequest }))

const { insecureHttpsModule } = await import('../src/instrument.mts')

describe('instrument', () => {
	it('initialises Sentry once and wires in the insecure https transport', () => {
		expect(init).toHaveBeenCalledTimes(1)
		const cfg = init.mock.calls[0][0] as { dsn?: string; transportOptions: { httpModule: unknown } }
		expect(cfg.transportOptions.httpModule).toBe(insecureHttpsModule)
	})

	it('request() disables TLS verification and delegates to https.request', () => {
		const options: { rejectUnauthorized?: boolean } = {}
		const callback = vi.fn()

		const returned = insecureHttpsModule.request(options as never, callback as never)

		expect(options.rejectUnauthorized).toBe(false)
		expect(httpsRequest).toHaveBeenCalledWith(options, callback)
		expect(returned).toBe('REQUEST')
	})
})
