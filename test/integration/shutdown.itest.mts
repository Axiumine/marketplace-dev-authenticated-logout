import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import Keygrip from 'keygrip'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
	createServer,
	ENDPOINT,
	gracefulShutdown,
	logListening,
	onUncaughtException,
	onUnhandledRejection
} from '../../src/index.mts'
import { disconnectAllDatabases } from '../../src/lib/db/disconnectAllDatabases.mts'
import { ITEST_KEYGRIP_KEYS } from '../../vitest.keygrip.mts'
import { asHash, REFRESH_SESSION } from '../helpers/sessionFixtures.mts'

/*
 * The process-lifecycle half of the service, exercised against the real Redis cluster.
 *
 * Everything here was previously unreachable from an integration test for one reason: it ends in
 * `process.exit()`. That is a tooling problem, not a "cannot be tested for real" problem — the exit
 * is the LAST statement of each path, so stubbing it lets the real work in front of it run against
 * the real Redis cluster and simply return instead of killing the runner.
 *
 * Nothing else is stubbed. `apolloServer.stop()` really drains, `httpServer.close()` really closes,
 * and `disconnectAllDatabases` really tears down the live Redis connection — which is exactly why
 * this file lives on its own: vitest isolates each test file in its own module registry, so the
 * connection destroyed below is this file's, not the one index.itest.mts is using.
 *
 * Unlike the sibling public/authenticated-resource services, this one has no MongoDB at all
 * (see src/index.mts / disconnectAllDatabases.mts) — Redis is the only datasource to tear down.
 */

const REDIS_KEY = process.env.REDIS_KEY as string

const keys = new Keygrip(
	ITEST_KEYGRIP_KEYS.map((key) => key.material),
	'sha512'
)

// A refresh cookie the way Koa emits it: the value plus its `.sig` Keygrip signature.
function signedCookie(refresh: string): string {
	return `refresh_token=${refresh}; refresh_token.sig=${keys.sign(`refresh_token=${refresh}`)}`
}

let exitSpy: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
	await RedisConnect()
})

afterAll(async () => {
	// Best-effort: most tests below have already torn this down. RedisDisconnect swallows an
	// already-closed client, so a repeat close here is harmless.
	await redisClient.close().catch(() => undefined)
})

describe('production hardening actually applies to a real server', () => {
	/*
	 * buildValidationRules only returns NoSchemaIntrospectionCustomRule + depthLimit(10) under
	 * NODE_ENV=production, and every other test in every suite runs as `test`, so that arm had
	 * never been exercised. Asserted by booting a real production-mode server and asking it for its
	 * schema over real HTTP — a unit call to buildValidationRules() would only prove the array was
	 * built, not that Apollo enforces it.
	 *
	 * authorizationLogoutHandler runs in front of Apollo on this service, so the request needs a
	 * credential to reach the validation stage at all. It used to be the `x-introspectioncode` header;
	 * that header now does nothing outside `development` and `test`, and the whole point of
	 * booting this server is that it is neither. So the request carries a real signed refresh cookie
	 * and the session hash behind it, exactly as a logged-in caller would — which also makes the
	 * assertion stronger: introspection is refused for an authenticated caller, not merely for an
	 * unauthenticated one.
	 */
	it('refuses introspection when booted as production', async () => {
		const realNodeEnv = process.env.NODE_ENV
		process.env.NODE_ENV = 'production'

		// The session a logout request is made against: the handler verifies the cookie's signature and
		// then reads this hash. `refresh:` is part of the key because verifySignedRefreshToken returns
		// the token already prefixed.
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)

		let server: Awaited<ReturnType<typeof createServer>> | undefined
		try {
			// The whole hash a login writer produces, not one field of it — see
			// `test/helpers/sessionFixtures.mts`.
			await redisClient.hSet(refreshKey, asHash(REFRESH_SESSION))

			server = await createServer(ITEST_KEYGRIP_KEYS)
			await new Promise<void>((resolve) => server!.httpServer.listen({ port: 0 }, () => resolve()))
			const { port } = server.httpServer.address() as AddressInfo

			const res = await fetch(`http://127.0.0.1:${port}${ENDPOINT}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: signedCookie(refresh), authorization: 'Bearer ' },
				body: JSON.stringify({ query: '{ __schema { queryType { name } } }' })
			})
			const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> }

			expect(json.data).toBeUndefined()
			expect(json.errors?.[0]?.message).toMatch(/introspection/i)
		} finally {
			process.env.NODE_ENV = realNodeEnv
			await redisClient.del(refreshKey)
			if (server) {
				await server.apolloServer.stop()
				await new Promise<void>((resolve) => server!.httpServer.close(() => resolve()))
			}
		}
	})

	// The other NODE_ENV=production arm: the listening banner is mirrored to Sentry as an info
	// event. logListening takes its env as a parameter precisely so this can be driven without
	// re-entering the production branch above.
	it('mirrors the listening banner to Sentry under production', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

		try {
			logListening({ ...process.env, NODE_ENV: 'production', PORT: '4030' })

			expect(info).toHaveBeenCalledWith(`Serving http://*:4030${ENDPOINT} for production.`)
		} finally {
			info.mockRestore()
		}
	})
})

describe('process-level error handlers', () => {
	beforeAll(() => {
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})

	it('exits 1 on an unhandled rejection', () => {
		onUnhandledRejection(new Error('itest unhandled rejection'))

		expect(exitSpy).toHaveBeenCalledWith(1)
	})

	it('exits 1 on an uncaught exception', () => {
		onUncaughtException(new Error('itest uncaught exception'))

		expect(exitSpy).toHaveBeenCalledWith(1)
	})
})

describe('gracefulShutdown against the real server and the real Redis cluster', () => {
	/*
	 * The whole SIGTERM path in one go: Apollo drains, the HTTP server closes, and its close
	 * callback runs disconnectAllDatabases(0) — the success arm — which really closes the Redis
	 * cluster client. Asserted on the connection itself, not on a spy call count, because the
	 * point is that the teardown actually happened.
	 */
	it('drains Apollo, closes the server, disconnects Redis and exits 0', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

		try {
			const { httpServer, apolloServer } = await createServer(ITEST_KEYGRIP_KEYS)
			await new Promise<void>((resolve) => httpServer.listen({ port: 0 }, () => resolve()))

			// Live before, so the assertions after mean something.
			expect((httpServer.address() as AddressInfo).port).toBeGreaterThan(0)
			expect(redisClient.isOpen).toBe(true)

			await gracefulShutdown('SIGTERM', apolloServer, httpServer)

			// gracefulShutdown fires disconnectAllDatabases from the close callback and does not
			// await it, so wait for the real teardown to land rather than racing it.
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 15000 })

			expect(httpServer.listening).toBe(false)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
		}
	})
})

describe('disconnectAllDatabases called again once everything is already down', () => {
	// RedisDisconnect swallows "The client is closed" by design, so a second call still takes the
	// success arm and exits with the code it was given. This pins that a repeated shutdown signal
	// cannot turn into a failure.
	it('still takes the success arm and honours a non-zero exit code', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

		try {
			await disconnectAllDatabases(3)

			expect(exit).toHaveBeenCalledWith(3)
		} finally {
			exit.mockRestore()
		}
	})
})

describe('disconnectAllDatabases when the teardown cannot finish in time', () => {
	/*
	 * The 5-second race in disconnectAllDatabases, lost for real — nothing is stubbed or faked.
	 *
	 * The previous describe block left this file's Redis connection closed, so it is reconnected
	 * here first. A BLPOP with no matching push is then issued on the real cluster and never
	 * awaited: node-redis's close() waits for the queue to drain before it resolves (that is
	 * exactly why the cluster driver's own #destroy comment warns "close() can hang if the server
	 * is not responding" — see @redis/client/dist/lib/cluster/cluster-slots.js), and a blocking
	 * command with nobody ever pushing to its key is a genuine, real reason for the queue to stay
	 * non-empty. The command's own 8s server-side timeout is deliberately longer than the 5s budget
	 * disconnectAllDatabases allows itself, so the race's timer — not the blocking command — is
	 * what wins, and the catch arm runs for real.
	 */
	it('exits 1 rather than the requested code when the 5s budget runs out', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		await RedisConnect()

		const key = `${REDIS_KEY}itest:blackhole:${randomUUID()}`
		const blocked = redisClient.blPop(key, 8).catch(() => undefined)
		// Routing a cluster command to the right node is itself async (slot lookup), so without
		// this the BLPOP below can still be in flight, not yet written to any socket, by the time
		// close() runs — and close() only waits for commands its queue already knows about.
		await new Promise((resolve) => setTimeout(resolve, 200))

		try {
			// 0 is requested, but the catch arm hardcodes 1 — a failed teardown must not be able to
			// report success to whatever supervises the process.
			await disconnectAllDatabases(0)

			expect(exit).toHaveBeenCalledWith(1)
			expect(exit).not.toHaveBeenCalledWith(0)
		} finally {
			exit.mockRestore()
			// The real close() call inside disconnectAllDatabases is still in flight in the
			// background — Promise.race does not cancel the loser — so wait for BLPOP's own
			// timeout to land before this file ends, rather than leaving it dangling.
			await blocked
		}
	})
})
