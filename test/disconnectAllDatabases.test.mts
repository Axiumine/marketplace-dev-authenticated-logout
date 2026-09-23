import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const RedisDisconnect = vi.fn()
const captureMessage = vi.fn()
const captureException = vi.fn()
const flush = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisDisconnect }))
vi.mock('@sentry/node', () => ({ captureMessage, captureException, flush }))

const { disconnectAllDatabases } = await import('../src/lib/db/disconnectAllDatabases.mts')

// process.exit is neutralized to a no-op: the function has a `never` return type, the no-op
// lets it carry on and the exit code is read from the spy without killing the vitest worker.
let exit: ReturnType<typeof vi.spyOn>

describe('disconnectAllDatabases', () => {
	beforeEach(() => {
		RedisDisconnect.mockReset().mockResolvedValue(undefined)
		captureMessage.mockReset()
		captureException.mockReset()
		flush.mockReset().mockResolvedValue(true)
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
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
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
		// ⚠️ B14: flushed on the FAILURE branch too — this is the exact event a fatal boot failure reports,
		// and it is the one Sentry event this whole function exists to guarantee is not dropped by the exit
		// two lines below.
		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	/*
	 * ⚠️ **B14, and the point of the test.** Merely asserting `flush` was called would still pass a
	 * `void Sentry.flush(2000)` mutant that fires the call and exits without ever letting it settle — the
	 * exact shape of the original bug, where the event was queued but the process was gone before the
	 * network call landed. Holding `flush`'s own promise open proves `process.exit` genuinely waits on it.
	 */
	it('does not exit until the Sentry flush itself has settled', async () => {
		let resolveFlush: (value: boolean) => void = () => undefined
		flush.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				resolveFlush = resolve
			})
		)

		const pending = disconnectAllDatabases()

		await vi.waitFor(() => expect(flush).toHaveBeenCalledExactlyOnceWith(2000))
		expect(exit).not.toHaveBeenCalled()

		resolveFlush(true)
		await pending

		expect(exit).toHaveBeenCalledExactlyOnceWith(0)
	})

	// The `.catch` guarding the flush (B14): a flush failure must not stop the requested exit code from
	// being honoured, on the success arm where there is nothing else to report.
	it('still exits with the requested code when the Sentry flush itself rejects', async () => {
		flush.mockRejectedValueOnce(new Error('sentry unreachable'))

		await disconnectAllDatabases(0)

		expect(exit).toHaveBeenCalledExactlyOnceWith(0)
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
