import http from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const disconnectAllDatabases = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// redisClient is imported transitively by the handler / resolvers; a bare stub is enough
// because the unit project never connects — only start()'s failure path is exercised here.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: {} }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))

const {
	ENDPOINT,
	REQUIRED_ENV_VARS,
	checkRequiredEnv,
	buildValidationRules,
	healthResponse,
	logListening,
	gracefulShutdown,
	onUnhandledRejection,
	onUncaughtException,
	start
} = await import('../src/index.mts')

describe('checkRequiredEnv', () => {
	it('passes when every required variable is set', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	it('throws naming the first missing variable', () => {
		expect(() => checkRequiredEnv({})).toThrow(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
	})

	/*
	 * Named as a literal, because the two tests above cannot see WHICH names the list carries: the
	 * first builds its passing environment out of the list itself, so a corrupted entry is satisfied
	 * by the very stub the corruption produced, and the second only ever reads REQUIRED_ENV_VARS[0].
	 *
	 * It matters more here than in the authorization services. This handler consults the code when
	 * there is no cookie and no Authorization header at all, so with the variable unset — and
	 * `${process.env.INTROSPECTION_CODE}` stringifying that to 'undefined' — a caller sending the
	 * literal string `undefined` skips the session lookup and reaches the resolver as a trusted
	 * internal caller. No MONGODB_URI assertion: this service connects Redis only.
	 */
	it('requires INTROSPECTION_CODE by name', () => {
		expect(REQUIRED_ENV_VARS).toContain('INTROSPECTION_CODE')
	})
})

describe('buildValidationRules', () => {
	it('is empty outside production', () => {
		expect(buildValidationRules({ NODE_ENV: 'test' })).toEqual([])
	})

	it('caps depth and blocks introspection in production', () => {
		expect(buildValidationRules({ NODE_ENV: 'production' })).toHaveLength(2)
	})
})

describe('healthResponse', () => {
	it('reports OK with a round-trippable ISO timestamp', () => {
		const res = healthResponse()
		expect(res.status).toBe('OK')
		expect(res.timestamp).toBe(new Date(res.timestamp).toISOString())
	})
})

describe('logListening', () => {
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureMessage.mockReset()
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	// Regression test for the dead HOSTNAME reference: the real call site in start() invokes
	// logListening() with NO arguments, falling back to process.env. A test that passes HOSTNAME
	// explicitly (as this file used to) never exercises that fallback and hid the `undefined` host
	// in the banner after HOSTNAME was dropped from REQUIRED_ENV_VARS and the env template.
	it('logs the exact banner from process.env when called with no argument, outside production', () => {
		vi.stubEnv('NODE_ENV', 'test')
		vi.stubEnv('PORT', '4030')

		logListening()

		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4030/logout for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('mirrors the exact banner to Sentry when called with no argument, in production', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('PORT', '80')

		logListening()

		expect(captureMessage).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/logout for production.', 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:80/logout for production.')
	})

	it('logs to the console only, outside production, when given an explicit env', () => {
		logListening({ NODE_ENV: 'test', PORT: '4030' })
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4030/logout for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors the banner to Sentry in production, when given an explicit env', () => {
		logListening({ NODE_ENV: 'production', PORT: '80' })
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(`Serving http://*:80${ENDPOINT} for production.`, 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith(`Serving http://*:80${ENDPOINT} for production.`)
	})
})

describe('gracefulShutdown', () => {
	beforeEach(() => {
		captureMessage.mockReset()
		disconnectAllDatabases.mockReset()
	})

	it('drains Apollo, closes the server and disconnects with code 0', async () => {
		const apolloServer = { stop: vi.fn().mockResolvedValue(undefined) }
		const httpServer = { close: vi.fn((cb: () => void) => cb()) }

		await gracefulShutdown('SIGTERM', apolloServer as never, httpServer as never)

		expect(captureMessage).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully...')
		expect(apolloServer.stop).toHaveBeenCalledTimes(1)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(0)
	})
})

describe('process handlers', () => {
	let exit: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	it('onUnhandledRejection reports the reason and exits 1', () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)
		expect(exit).toHaveBeenCalledWith(1)
	})

	it('onUncaughtException reports the error and exits 1', () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(exit).toHaveBeenCalledWith(1)
	})
})

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		disconnectAllDatabases.mockReset()
		RedisConnect.mockReset()
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		errorLog.mockRestore()
		vi.unstubAllEnvs()
	})

	it('reports to Sentry and disconnects with code 1 when Redis fails to connect', async () => {
		const error = new Error('redis boom')
		RedisConnect.mockRejectedValueOnce(error)

		await start()

		expect(RedisConnect).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})
})

describe('start (success path)', () => {
	// Spying on the prototype, not mocking the 'http' module: createServer() still returns a
	// real http.Server (Koa/Apollo/ApolloServerPluginDrainHttpServer all get a genuine
	// EventEmitter), only `.listen` is short-circuited so the test never binds a real socket.
	let listen: ReturnType<typeof vi.spyOn>
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		disconnectAllDatabases.mockReset()
		RedisConnect.mockReset()
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
		listen = vi
			.spyOn(http.Server.prototype, 'listen')
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.mockImplementation(function (this: any, options: unknown, cb?: () => void) {
				cb?.()
				return this
			})
	})
	afterEach(() => {
		listen.mockRestore()
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	// This is also the regression test for the dead `hostname` key: `net.Server.listen` has no
	// such option — Node silently ignored it and bound every interface regardless (see the
	// comment above the real call in src/index.mts). Asserting the exact options object means a
	// re-added `host`/`hostname` key, or a dropped `port`, fails this test.
	it('binds every interface: passes only PORT to listen, no host key', async () => {
		RedisConnect.mockResolvedValueOnce(undefined)

		const srv = await start()

		expect(listen).toHaveBeenCalledExactlyOnceWith({ port: 'x' }, expect.any(Function))

		await srv?.apolloServer.stop()
	})
})
