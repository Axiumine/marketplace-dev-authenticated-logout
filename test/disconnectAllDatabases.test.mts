import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const RedisDisconnect = vi.fn()
const captureMessage = vi.fn()
const captureException = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisDisconnect }))
vi.mock('@sentry/node', () => ({ captureMessage, captureException }))

const { disconnectAllDatabases } = await import('../src/lib/db/disconnectAllDatabases.mts')

// process.exit is neutralized to a no-op: the function has a `never` return type, the no-op
// lets it carry on and the exit code is read from the spy without killing the vitest worker.
let exit: ReturnType<typeof vi.spyOn>

describe('disconnectAllDatabases', () => {
	beforeEach(() => {
		RedisDisconnect.mockReset().mockResolvedValue(undefined)
		captureMessage.mockReset()
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('disconnects Redis and exits with 0 by default', async () => {
		await disconnectAllDatabases()

		expect(RedisDisconnect).toHaveBeenCalledTimes(1)
		expect(captureMessage).toHaveBeenCalledWith('All databases disconnected successfully')
		expect(exit).toHaveBeenCalledExactlyOnceWith(0)
	})

	it('propagates the requested exit code', async () => {
		await disconnectAllDatabases(3)

		expect(exit).toHaveBeenCalledExactlyOnceWith(3)
	})

	it('exits with 1 and reports to Sentry if the disconnection fails', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))

		await disconnectAllDatabases()

		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { detail: 'Error during database disconnection' }
		})
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	it('exits with 1 if the disconnection exceeds the 5s timeout', async () => {
		vi.useFakeTimers()
		RedisDisconnect.mockReturnValueOnce(new Promise(() => {})) // never resolves

		const pending = disconnectAllDatabases()
		await vi.advanceTimersByTimeAsync(5000)
		await pending

		expect(captureException).toHaveBeenCalledTimes(1)
		expect(captureException.mock.calls[0][0]).toMatchObject({ message: 'Database disconnection timeout' })
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})
})
