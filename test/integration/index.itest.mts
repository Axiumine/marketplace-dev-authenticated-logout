import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import Keygrip from 'keygrip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (Redis datasource, handler); this is a
// belt-and-suspenders load so KEYGRIP_KEY_* are present when this file's top level reads them.
dotenv.config()

import { ENDPOINT, start } from '../../src/index.mts'

const REDIS_KEY = process.env.REDIS_KEY as string
const INTROSPECTION_CODE = process.env.INTROSPECTION_CODE as string
// Must match the server's cookie signer exactly (see createServer): same keys, same SHA-512.
const keys = new Keygrip([process.env.KEYGRIP_KEY_1 as string, process.env.KEYGRIP_KEY_2 as string], 'sha512')

// A refresh cookie the way Koa emits it: the value plus its `.sig` Keygrip signature.
function signedCookie(refresh: string): string {
	return `refresh_token=${refresh}; refresh_token.sig=${keys.sign(`refresh_token=${refresh}`)}`
}

let httpServer: Server
let base: string

// Keys seeded directly by this file (not by the SUT's own logout cleanup) are tracked here at
// creation time — not in a per-test `finally` — so a seed that throws, or an assertion that fails
// before a test reaches its own cleanup, still cannot leak a session into this service's own
// marketplaceDev:itest:authenticatedLogout: keyspace. logout itself deletes what it consumes, so only
// the tests that seed a session the resolver never reaches (auth-middleware short-circuits, or
// read-only queries) push here.
const seededKeys: string[] = []

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster')
	httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`
})

/**
 * Cleanup must never abort halfway. A single failed del — a cluster MOVED mid-resharding, a handle
 * closed early — would otherwise strand every key registered after it, and a stranded key sits in
 * the cluster for its whole TTL.
 */
async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

afterAll(async () => {
	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	// Cluster: one key per del() call, never a multi-key del (CROSSSLOT).
	for (const key of seededKeys) {
		await drainSafely(key, () => redisClient.del(key))
	}
	await redisClient.close()
})

/** POST `mutation { logout }` with whatever headers the caller wants to try. */
function callLogout(headers: Record<string, string>) {
	return fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query: 'mutation { logout }' })
	})
}

/** POST `{ helloLogout { txt } }` with whatever headers the caller wants to try. */
function callHelloLogout(headers: Record<string, string>) {
	return fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query: '{ helloLogout { txt } }' })
	})
}

/**
 * The success half of a logout assertion: 200, no GraphQL errors, `logout: true`. Four tests make
 * those same three claims and differ only in what they check afterwards, so the shared part lives
 * here. Reads the body, which a `Response` allows once — the caller can still read the headers.
 */
async function expectLoggedOut(res: Response) {
	expect(res.status).toBe(200)
	const json = (await res.json()) as { data?: { logout?: boolean }; errors?: unknown }
	expect(json.errors).toBeUndefined()
	expect(json.data?.logout).toBe(true)
}

describe('logout service (integration, real Redis cluster)', () => {
	it('verifies both sessions in Redis, deletes them and returns true', async () => {
		const refresh = randomUUID()
		const accessToken = `access:${randomUUID()}`
		const refreshKey = sessionKey(`refresh:${refresh}`)
		const accessKey = sessionKey(accessToken)

		// Seed the sessions the handler expects to find on the live cluster, TTLs included — that
		// is how the authorization tier writes them, and an expiring key is what has to disappear.
		await redisClient.hSet(refreshKey, 'id', 'itest')
		await redisClient.hSet(accessKey, '_id', 'itest')
		await redisClient.expire(refreshKey, 600)
		await redisClient.expire(accessKey, 600)

		const res = await callLogout({ cookie: signedCookie(refresh), authorization: `Bearer ${accessToken}` })

		await expectLoggedOut(res)

		// The resolver must have removed both keys from the real cluster — the whole key, not just
		// its fields. `exists` is the honest check: a key holding a TTL would still report 1.
		expect(await redisClient.exists(refreshKey)).toBe(0)
		expect(await redisClient.exists(accessKey)).toBe(0)

		// …and the refresh cookie is cleared on the way out.
		const cleared = res.headers.getSetCookie().find((cookie) => cookie.startsWith('refresh_token='))
		expect(cleared).toBeDefined()
		expect(cleared?.startsWith('refresh_token=;')).toBe(true)
	})

	/*
	 * ⚠️ E13-S02, against the real cluster: a session seeded in the **pre-cutover shape** — the token as
	 * the key name — is still found and still revoked. This is the case the dual-read exists for, and it
	 * is the one nothing else can prove: on the deploy that turns hashing on, every session in Redis looks
	 * exactly like the one seeded here.
	 *
	 * ⚠️ **When E13-S10 deletes the fallback, this test goes with it**, and the shape it seeds becomes
	 * unreadable by design. It is not a regression test for a behaviour that stays.
	 */
	it('finds and revokes a session written before the cutover, under the raw key', async () => {
		const refresh = randomUUID()
		const rawKey = `${REDIS_KEY}refresh:${refresh}`
		await redisClient.hSet(rawKey, 'id', 'itest')
		await redisClient.expire(rawKey, 600)

		const res = await callLogout({ cookie: signedCookie(refresh), authorization: `Bearer access:${randomUUID()}` })

		await expectLoggedOut(res)
		expect(await redisClient.exists(rawKey)).toBe(0)
		// The hashed twin was never written, and the logout must not have invented it.
		expect(await redisClient.exists(sessionKey(`refresh:${refresh}`))).toBe(0)
	})

	// The handler treats the access session as optional: an access token that already expired off
	// the cluster is "no problem", and the refresh session still has to go. Only a real cluster can
	// produce that state — a mock would have to be told to.
	it('still clears the refresh session when the access token has already expired away', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		await redisClient.hSet(refreshKey, 'id', 'itest')

		const res = await callLogout({
			cookie: signedCookie(refresh),
			// Never written to Redis: this is the expired-access case.
			authorization: `Bearer access:${randomUUID()}`
		})

		await expectLoggedOut(res)
		expect(await redisClient.exists(refreshKey)).toBe(0)
	})

	// Logging out twice: the second call finds no refresh session and is answered by
	// throwAlreadyDone — 204, which by definition carries no body.
	it('answers 204 when the refresh session is already gone from the cluster', async () => {
		const res = await callLogout({
			cookie: signedCookie(randomUUID()),
			authorization: `Bearer access:${randomUUID()}`
		})

		expect(res.status).toBe(204)
	})

	// The handler's success check is `hGet(..., 'id') != null` — not "the key exists". Seed a
	// refresh hash on the real cluster under a different field name: `exists` would say 1, but the
	// field lookup the handler actually runs still misses. Only a real hash can carry this
	// distinction; a mock would have to be told to treat "exists" and "has this field" differently.
	it('answers 204 when the refresh hash exists but lacks the field the handler reads', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		seededKeys.push(refreshKey)

		await redisClient.hSet(refreshKey, 'notId', 'itest')

		const res = await callLogout({
			cookie: signedCookie(refresh),
			authorization: `Bearer access:${randomUUID()}`
		})

		expect(res.status).toBe(204)
		// throwAlreadyDone fires before the resolver runs, so the malformed hash is untouched —
		// proof the 204 came from the missing field, not from a delete that happened anyway.
		expect(await redisClient.exists(refreshKey)).toBe(1)
	})

	/*
	 * `Bearer ` with nothing after it. The handler's `accessToken !== ''` guard reads as if this
	 * were the empty-token case, but it is not: HTTP strips trailing whitespace from a header value
	 * before any JS runs, so what arrives is the bare word `Bearer`, and `.replace('Bearer ', '')`
	 * finds nothing to remove and hands the guard `"Bearer"` — truthy.
	 *
	 * The lookup therefore runs — twice now, against the digest of `Bearer` and then against the raw
	 * key `<REDIS_KEY>Bearer` — misses both, and the request proceeds as an expired-access logout.
	 */
	it('treats a bare `Bearer` as a real token, misses, and still logs out', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		await redisClient.hSet(refreshKey, 'id', 'itest')

		const res = await callLogout({ cookie: signedCookie(refresh), authorization: 'Bearer ' })

		await expectLoggedOut(res)
		expect(await redisClient.exists(refreshKey)).toBe(0)
	})

	/*
	 * The guard's other side, and it IS reachable over real HTTP: an Authorization header can carry
	 * an explicit empty value. `authorization: ''` arrives as the defined empty string — distinct
	 * from the header being absent, which is what the introspection fallback above actually guards
	 * against. `.replace('Bearer ', '')` on `''` still returns `''`, so `accessToken !== ''` is
	 * false and the access-token lookup is skipped outright; the refresh half of logout still runs.
	 */
	it('skips the access-token lookup outright when the Authorization header is present but empty', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		await redisClient.hSet(refreshKey, 'id', 'itest')

		const res = await callLogout({ cookie: signedCookie(refresh), authorization: '' })

		await expectLoggedOut(res)
		expect(await redisClient.exists(refreshKey)).toBe(0)
	})

	// No cookie header at all, and no introspection code to excuse it: the first guard in
	// authorizationLogoutHandler refuses before Redis is ever touched.
	it('rejects a request with no cookie header at all', async () => {
		const res = await callLogout({ authorization: 'Bearer access:xyz' })

		expect(res.status).toBe(412)
		const json = (await res.json()) as { message?: string; description?: string }
		expect(json.message).toBe('Precondition Failed')
		expect(json.description).toBe('No authorization cookie.')
	})

	// Second guard, reached only once the cookie guard has passed: a valid signed cookie but no
	// Authorization header. The access token is optional to the *resolver*, not to the handler.
	it('rejects a signed refresh cookie that arrives without an Authorization header', async () => {
		const res = await callLogout({ cookie: signedCookie(randomUUID()) })

		expect(res.status).toBe(412)
		const json = (await res.json()) as { message?: string; description?: string }
		expect(json.message).toBe('Precondition Failed')
		expect(json.description).toBe('No authorization header.')
	})

	/*
	 * The introspection bypass and the resolver disagree, and this pins what really happens.
	 *
	 * With a valid x-introspectioncode and neither cookie nor Authorization header, the handler
	 * takes its `introspection` exit and never assigns `ctx.state`. The resolver's first statement
	 * then dereferences `ctx.state.user.refreshToken` on an undefined user — a TypeError, raised
	 * inside its own try, swallowed by `catch { Sentry.captureException(e) }`, and reported to the
	 * caller as a perfectly ordinary `true`.
	 *
	 * So logout answers success while deleting nothing. That is the only way to reach that catch
	 * with real infrastructure: no Redis failure is needed, and none is simulated here.
	 */
	it('answers true without deleting anything when the introspection code replaces the session', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		seededKeys.push(refreshKey)
		await redisClient.hSet(refreshKey, 'id', 'itest')

		const res = await callLogout({ 'x-introspectioncode': INTROSPECTION_CODE })

		expect(res.status).toBe(200)
		const json = (await res.json()) as { data?: { logout?: boolean }; errors?: unknown }
		expect(json.errors).toBeUndefined()
		expect(json.data?.logout).toBe(true)

		// Nothing was consumed: the "success" is the swallowed TypeError, not a logout.
		expect(await redisClient.exists(refreshKey)).toBe(1)
		// …and no cookie was cleared either, because ctx.cookies.set never ran.
		expect(res.headers.getSetCookie().find((cookie) => cookie.startsWith('refresh_token='))).toBeUndefined()
	})

	// verifySignedRefreshToken (called before any Redis lookup) rejects a refresh cookie whose
	// `.sig` companion is missing entirely. Real Keygrip, real cookie parsing — a mock resolver
	// would never notice if this guard were deleted.
	it('rejects a refresh cookie that is present but unsigned', async () => {
		const res = await callLogout({
			cookie: `refresh_token=${randomUUID()}`,
			authorization: 'Bearer access:xyz'
		})

		expect(res.status).toBe(499)
		const json = (await res.json()) as { message?: string; description?: string }
		expect(json.message).toBe('Token Required')
		expect(json.description).toBe('Refresh Token Signature Required.')
	})

	// Same guard, other half: a `.sig` that does not verify against the real KEYGRIP_KEY_1/2 pair
	// this server was started with. Proves the signer configured in createServer and the one this
	// file's signedCookie() uses to build valid cookies are the same keys — a wrong or rotated key
	// would make every "valid" cookie in this suite fail exactly like this one.
	it('rejects a refresh cookie that is present but tampered', async () => {
		const res = await callLogout({
			cookie: `refresh_token=${randomUUID()}; refresh_token.sig=not-a-real-signature`,
			authorization: 'Bearer access:xyz'
		})

		expect(res.status).toBe(401)
		const json = (await res.json()) as { message?: string; description?: string }
		expect(json.message).toBe('Unauthorized')
		expect(json.description).toBe('Invalid Refresh Cookie signature')
	})

	// helloLogout runs through the same authorizationLogoutHandler as logout, so it needs a real
	// session too — but unlike logout it only reads: both sessions the auth middleware validated
	// must still be on the cluster afterwards.
	it('answers helloLogout over HTTP once the real session checks in authorizationLogoutHandler pass', async () => {
		const refresh = randomUUID()
		const accessToken = `access:${randomUUID()}`
		const refreshKey = sessionKey(`refresh:${refresh}`)
		const accessKey = sessionKey(accessToken)
		seededKeys.push(refreshKey, accessKey)

		await redisClient.hSet(refreshKey, 'id', 'itest')
		await redisClient.hSet(accessKey, '_id', 'itest')
		await redisClient.expire(refreshKey, 600)
		await redisClient.expire(accessKey, 600)

		const res = await callHelloLogout({ cookie: signedCookie(refresh), authorization: `Bearer ${accessToken}` })

		expect(res.status).toBe(200)
		const json = (await res.json()) as { data?: { helloLogout?: { txt: string } }; errors?: unknown }
		expect(json.errors).toBeUndefined()
		expect(json.data?.helloLogout).toEqual({ txt: 'Hello from helloLogout' })

		// Read-only: helloLogout must not consume the sessions the auth middleware already checked.
		expect(await redisClient.exists(refreshKey)).toBe(1)
		expect(await redisClient.exists(accessKey)).toBe(1)
	})

	it('serves /health when the introspection code bypasses auth', async () => {
		const res = await fetch(`${base}/health`, { headers: { 'x-introspectioncode': INTROSPECTION_CODE } })

		expect(res.status).toBe(200)
		const json = (await res.json()) as { status: string; timestamp: string }
		expect(json.status).toBe('OK')
	})

	it('falls through to 404 for an unknown path', async () => {
		const res = await fetch(`${base}/nope`, { headers: { 'x-introspectioncode': INTROSPECTION_CODE } })

		expect(res.status).toBe(404)
	})
})
