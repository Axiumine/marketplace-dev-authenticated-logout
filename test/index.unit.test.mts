import http from 'http'
import Keygrip from 'keygrip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const disconnectAllDatabases = vi.fn()
const loadKeygrip = vi.fn()

// Two 64-byte keys, newest first, exactly as loadKeygrip answers. Written as bytes: nothing here is a
// real signing key, and the pair has to be distinguishable so the order can be asserted.
const KEYS = [
	{ id: 'k2', material: Buffer.alloc(64, 17).toString('base64'), createdAt: '2026-08-12T09:14:22.581Z' },
	{ id: 'k1', material: Buffer.alloc(64, 34).toString('base64'), createdAt: '2026-05-01T08:00:00.000Z' }
]

// Identifiable, so the call to loadKeygrip can be asserted to have received THIS client rather than
// merely something object-shaped.
const redisClient = { id: 'redis-client' }

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// redisClient is imported transitively by the handler / resolvers; a bare stub is enough
// because the unit project never connects — only start()'s failure path is exercised here.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))
// Mocked because the real one reads a Redis hash and unwraps it under KEYGRIP_KEK (ADR-034), and the
// unit project connects to nothing. What start() owes it is that it is called with this service's own
// name, right after the connect, and that its refusal is as fatal as a datasource failure — asserted
// on both arms below.
vi.mock('@axiumine/marketplace-common/others/loadKeygrip', () => ({ loadKeygrip }))

const {
	ENDPOINT,
	SERVICE_NAME,
	REQUIRED_ENV_VARS,
	checkRequiredEnv,
	buildValidationRules,
	healthResponse,
	logListening,
	gracefulShutdown,
	onUnhandledRejection,
	onUncaughtException,
	createServer,
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

	/*
	 * ⚠️ ADR-034, and the same literal-name argument as the test above. The KEK is the only cookie-key
	 * material this service still reads from its environment; the signing keys themselves come from
	 * Redis. The two old names are asserted GONE, not merely absent from the code: leaving them in the
	 * boot contract would keep a service refusing to start over variables nothing reads any more.
	 */
	it('requires the KEK by name, and no longer the signing keys themselves', () => {
		expect(REQUIRED_ENV_VARS).toContain('KEYGRIP_KEK')
		expect(REQUIRED_ENV_VARS).not.toContain('KEYGRIP_KEY_1')
		expect(REQUIRED_ENV_VARS).not.toContain('KEYGRIP_KEY_2')
	})
})

// The name this service writes into the keygrip holders table. Asserted as a literal because the
// table is how an operator tells five services apart, and a row nobody recognises is worse than no row.
describe('SERVICE_NAME', () => {
	it('is the repository name', () => {
		expect(SERVICE_NAME).toBe('marketplace-dev-authenticated-logout')
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
		loadKeygrip.mockReset().mockResolvedValue({ version: 1, fp: 'c77808de4139', keys: KEYS })
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

	/*
	 * ⚠️ The refusal this whole design exists for. A service that could not unwrap the record and started
	 * anyway would read — and this one also CLEARS — session cookies signed with keys no sibling agrees
	 * on, so a logout would silently fail to invalidate the cookie the user is still holding. Fatal, on
	 * the same path as a datasource failure.
	 */
	it('reports to Sentry and disconnects with code 1 when the keygrip record cannot be read', async () => {
		const error = new Error('KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 3 (c77808de4139).')
		RedisConnect.mockResolvedValueOnce(undefined)
		loadKeygrip.mockRejectedValueOnce(error)

		await start()

		expect(errorLog).toHaveBeenCalledExactlyOnceWith('error', error)
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
		loadKeygrip.mockReset().mockResolvedValue({ version: 1, fp: 'c77808de4139', keys: KEYS })
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

	/*
	 * ⚠️ Two things at once, and both are ordering. The keys are read with THIS service's own name — the
	 * holders table is worthless if five services write the same label — and they are read only once the
	 * Redis connect has resolved, because that connect is what answers them. A boot that is going to be
	 * refused is then refused before the server is built.
	 */
	it('reads the signing keys under its own name, right after the Redis connect', async () => {
		RedisConnect.mockResolvedValueOnce(undefined)

		const srv = await start()

		expect(loadKeygrip).toHaveBeenCalledExactlyOnceWith(redisClient, SERVICE_NAME)
		expect(RedisConnect.mock.invocationCallOrder[0]).toBeLessThan(loadKeygrip.mock.invocationCallOrder[0])

		await srv?.apolloServer.stop()
	})
})

// ⚠️ **`app.proxy` off is load-bearing, not an unset default nobody thought about.** With it off,
// `ctx.ip` is the socket address — nginx's own — so no client address is reachable in this process
// at all, which is the design: the per-caller rate limit is the edge's (`conf.d/20-rate-limit.conf`
// keys its zones on `$binary_remote_addr` after `real_ip_header CF-Connecting-IP`), and nothing here
// can write a visitor's address to Redis, to a log line or to Sentry. Turning it on would silently
// start trusting `X-Forwarded-For` and start producing real addresses everywhere `ctx.ip` is read.
// A comment cannot prevent that; this test can, and it is the reason the setting is never assigned.
describe('app.proxy', () => {
	it('is off on the constructed Koa app', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')

		const { app, apolloServer } = await createServer(KEYS)

		expect(app.proxy).toBeFalsy()

		await apolloServer.stop()
		vi.unstubAllEnvs()
	})
})

/*
 * ⚠️ What `Keygrip` is built from, and in which order (ADR-034). Signatures are compared rather than
 * the array being read back, because `Keygrip` keeps its keys private — and comparing signatures is
 * also what proves the algorithm is still sha512 and that the *material* is what reaches it, not the
 * key ids or the whole objects.
 */
describe('the signing keys', () => {
	it('signs with the first key, verifies with the older one, and stays sha512', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')

		const { apolloServer, keys } = await createServer(KEYS)
		const newest = new Keygrip([KEYS[0].material], 'sha512')
		const oldest = new Keygrip([KEYS[1].material], 'sha512')

		// Index 0 is the key that signs — the array order decides which, and reversing it would make
		// this service sign with a key its siblings are only verifying with.
		expect(keys.sign('session-cookie')).toBe(newest.sign('session-cookie'))
		expect(keys.sign('session-cookie')).not.toBe(oldest.sign('session-cookie'))

		// And the older key still verifies, at its own index: this is what carries already-issued
		// cookies across a rotation instead of logging everyone out.
		expect(keys.index('session-cookie', oldest.sign('session-cookie'))).toBe(1)

		await apolloServer.stop()
		vi.unstubAllEnvs()
	})
})
