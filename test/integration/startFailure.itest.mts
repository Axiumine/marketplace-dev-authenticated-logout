import { afterAll, describe, expect, it, vi } from 'vitest'

/*
 * start()'s catch arm — the boot-failure path — driven for real.
 *
 * No fault is simulated with a mock: the connection details are made genuinely wrong before the
 * Redis module is first evaluated, and the real driver raises the real error.
 *
 * That "before the module is first evaluated" requirement is why this file has no static imports
 * of src/index.mts (or of @axiumine/koa-utils/dataSources/Redis): the redisClient the koa-utils
 * package exports is built once, at module load time, from process.env.REDIS_* — a `createCluster`
 * call captures the rootNodes/credentials as literal values right then, so mutating process.env
 * afterwards has no effect on an already-constructed client. Every import below is therefore done
 * dynamically, inside the test, after the environment has been corrupted — the only way to make
 * the client that gets built actually be the broken one.
 *
 * Its own file for the usual reason too: it must run with nothing connected yet, and vitest gives
 * each test file its own module registry, so this one starts from a clean slate.
 */
describe('start() when Redis genuinely refuses the connection', () => {
	const realPassword = process.env.REDIS_PASSWORD

	afterAll(async () => {
		process.env.REDIS_PASSWORD = realPassword
	})

	it('logs, tears down what came up, and exits 1', async () => {
		// Truthy, so checkRequiredEnv() is satisfied and the failure happens where it is meant to —
		// in the driver, not in the env guard. Wrong on every root node, so the cluster's discovery
		// step (which uses reconnectStrategy: false for exactly this probe — see
		// @redis/client/dist/lib/cluster/cluster-slots.js #getShards) fails fast with a real
		// authentication error instead of retrying forever, the way a normal client connection would.
		process.env.REDIS_PASSWORD = 'itest-wrong-password'

		const { start } = await import('../../src/index.mts')
		const { redisClient } = await import('@axiumine/koa-utils/dataSources/Redis')

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			// Resolves rather than throwing: the catch handles the error and (normally) exits.
			await expect(start()).resolves.toBeUndefined()

			expect(errorLog).toHaveBeenCalled()
			expect(exit).toHaveBeenCalledWith(1)

			// The connection genuinely never came up.
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
			errorLog.mockRestore()
			// Best-effort: disconnectAllDatabases already attempted this on the way out, so a
			// second close is expected to be a no-op, not a fresh failure.
			await redisClient.close().catch(() => undefined)
		}
	})

	/*
	 * The env guard runs OUTSIDE start()'s try, so a missing variable is not caught, not reported
	 * to Sentry, and never reaches disconnectAllDatabases — it propagates straight out of start()
	 * and the process dies without touching a datasource. Driven through start() rather than by
	 * calling checkRequiredEnv() directly, so it is that ordering being tested and not just the
	 * guard's own loop.
	 *
	 * Reuses the module already imported above (dynamic import of the same specifier is cached, not
	 * re-evaluated) — safe here because checkRequiredEnv reads process.env at call time and never
	 * touches Redis, so the still-broken REDIS_PASSWORD from the previous test cannot affect it.
	 */
	it('refuses to boot at all, and connects nothing, when a required variable is missing', async () => {
		const realKey = process.env.KEYGRIP_KEY_1
		delete process.env.KEYGRIP_KEY_1

		try {
			const { start } = await import('../../src/index.mts')
			const { redisClient } = await import('@axiumine/koa-utils/dataSources/Redis')

			await expect(start()).rejects.toThrow('Missing required environment variable: KEYGRIP_KEY_1')

			expect(redisClient.isOpen).toBe(false)
		} finally {
			process.env.KEYGRIP_KEY_1 = realKey
		}
	})
})
