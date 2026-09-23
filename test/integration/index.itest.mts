import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import Keygrip from 'keygrip'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (Redis datasource, handler); this is a
// belt-and-suspenders load so REDIS_* and MONGODB_URI are present when this file's top level reads them.
dotenv.config()

import { ENDPOINT, start } from '../../src/index.mts'
import { ITEST_KEYGRIP_KEYS } from '../../vitest.keygrip.mts'
import { ACCESS_SESSION, asHash, REFRESH_SESSION, refreshSessionWithoutIdentity } from '../helpers/sessionFixtures.mts'

const REDIS_KEY = process.env.REDIS_KEY as string
// Must match the server's cookie signer exactly (see createServer): same keys, same SHA-512.
const keys = new Keygrip(
	ITEST_KEYGRIP_KEYS.map((key) => key.material),
	'sha512'
)

// A refresh cookie the way Koa emits it: the value plus its `.sig` Keygrip signature.
function signedCookie(refresh: string): string {
	return `refresh_token=${refresh}; refresh_token.sig=${keys.sign(`refresh_token=${refresh}`)}`
}

let keygripWatch: NodeJS.Timeout
let keygripSubscriber: { close(): Promise<unknown> }

let httpServer: Server
let base: string
// The Koa app itself (B1): exposed so the rotation suite below can do exactly what `onKeys` does —
// reassign `app.keys` in place — without a live Redis pub/sub round trip.
let app: NonNullable<Awaited<ReturnType<typeof start>>>['app']

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
	app = server.app
	// Both belong to the live key watch (ADR-034), and both have to be handed back for the drain below:
	// the timer is unref'd but still fires while the suite runs, and the subscriber is a second
	// connection nothing else in this file knows about.
	keygripWatch = server.keygripWatch
	keygripSubscriber = server.keygripSubscriber
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
	// The watch first: a poll that fires against a closing client would report an error nobody caused.
	clearInterval(keygripWatch)
	await drainSafely('keygrip subscriber', () => keygripSubscriber.close())

	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	// Cluster: one key per del() call, never a multi-key del (CROSSSLOT).
	for (const key of seededKeys) {
		await drainSafely(key, () => redisClient.del(key))
	}
	await redisClient.close()
})

/*
 * ⚠️ **The sessions are seeded whole, in the shape the writers write** — see
 * `test/helpers/sessionFixtures.mts` for why. Over a live cluster the argument is even simpler than it is
 * in the unit suite: if the handler asks for a field no login writes, the lookup really misses, and the
 * request really comes back 204 instead of 200.
 */

/** Writes the refresh hash a login writer produces, under whichever key shape the caller is testing. */
function seedRefreshSession(key: string) {
	return redisClient.hSet(key, asHash(REFRESH_SESSION))
}

/** Writes the access hash a login writer produces. */
function seedAccessSession(key: string) {
	return redisClient.hSet(key, asHash(ACCESS_SESSION))
}

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
 * The success half of a logout assertion: 200, no GraphQL errors, `logout: true`. Five tests make
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
		await seedRefreshSession(refreshKey)
		await seedAccessSession(accessKey)
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
	 * ⚠️ **The inverted raw-key test**, against the real cluster. The seed is byte-for-byte the
	 * one that used to prove the dual-read worked — a whole refresh session under the **pre-cutover shape**,
	 * the token as the key name — and the expected answer is now its opposite: 204, the session is not
	 * found, and the key is still sitting there untouched afterwards.
	 *
	 * Inverted rather than deleted, because the seed is the only fixture that can tell "the fallback is
	 * gone" from "the fallback is spelled differently". A source grep proves the constant left; only a live
	 * cluster holding a key of that exact shape proves nothing reads it. Every other 204 test here seeds
	 * nothing at all and would pass against a service that still had the fallback.
	 *
	 * The key is registered for the drain: the resolver never reaches it, so nothing deletes it but
	 * `afterAll`. That registration is itself part of the assertion — a logout that still found the raw
	 * shape would leave `exists` at 0 and fail two lines below.
	 */
	it('refuses a session written before the cutover under the raw key, and leaves it alone', async () => {
		const refresh = randomUUID()
		const rawKey = `${REDIS_KEY}refresh:${refresh}`
		seededKeys.push(rawKey)
		await seedRefreshSession(rawKey)
		await redisClient.expire(rawKey, 600)

		const res = await callLogout({ cookie: signedCookie(refresh), authorization: `Bearer access:${randomUUID()}` })

		// throwAlreadyDone: the digest of this token names nothing, and that is the only name looked up.
		expect(res.status).toBe(204)
		// Untouched — not read, not revoked. A pre-cutover session is now unreachable, by design.
		expect(await redisClient.exists(rawKey)).toBe(1)
		// And the logout invented no hashed twin on its way to the refusal.
		expect(await redisClient.exists(sessionKey(`refresh:${refresh}`))).toBe(0)
	})

	/*
	 * ⚠️ **The access-key residual, against the live cluster.** The header names an access token that
	 * is no longer there — an ordinary state, since a rotation kills the access token it replaces and the
	 * tab sending this logout has not refreshed since another one did — so `authorizationLogoutHandler`
	 * leaves `accessToken` unset and every name the resolver could once reach for is absent. The token
	 * that *is* live is the one the last refresh minted, and until the session recorded its key nothing
	 * here could name it: it survived the logout, in no family and in no index row, for up to ninety-one
	 * minutes after the user was told they were out.
	 *
	 * Both keys are seeded whole and with TTLs, because a key holding an expiry is what has to disappear.
	 */
	it('retires the access session the refresh hash names, when the presented token is already gone', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		const boundAccessKey = sessionKey(`access:${randomUUID()}`)

		await redisClient.hSet(refreshKey, { ...asHash(REFRESH_SESSION), accessKey: boundAccessKey })
		await seedAccessSession(boundAccessKey)
		await redisClient.expire(refreshKey, 600)
		await redisClient.expire(boundAccessKey, 600)

		const res = await callLogout({
			cookie: signedCookie(refresh),
			// Never written to Redis: the token this tab still holds was rotated away.
			authorization: `Bearer access:${randomUUID()}`
		})

		await expectLoggedOut(res)
		expect(await redisClient.exists(refreshKey)).toBe(0)
		expect(await redisClient.exists(boundAccessKey)).toBe(0)
	})

	// The handler treats the access session as optional: an access token that already expired off
	// the cluster is "no problem", and the refresh session still has to go. Only a real cluster can
	// produce that state — a mock would have to be told to.
	it('still clears the refresh session when the access token has already expired away', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		await seedRefreshSession(refreshKey)

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

	/*
	 * The handler's success check is `hGet(..., '_id') != null` — not "the key exists". Seed the real
	 * session hash on the real cluster with its identity field removed: `exists` says 1, `hGetAll` returns
	 * four populated fields, and the lookup the handler actually runs still misses. Only a real hash can
	 * carry that distinction; a mock would have to be told to treat "exists" and "has this field"
	 * differently.
	 *
	 * ⚠️ Seeded from `IRefreshData` minus `_id` rather than from an invented field name: a hash
	 * whose only field is one no writer writes proves nothing about which field the reader should ask for,
	 * and that is the assertion the previous version of this test was quietly making.
	 */
	it('answers 204 when the refresh hash exists but lacks the identity field the handler reads', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		seededKeys.push(refreshKey)

		await redisClient.hSet(refreshKey, refreshSessionWithoutIdentity())

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
		await seedRefreshSession(refreshKey)

		const res = await callLogout({ cookie: signedCookie(refresh), authorization: 'Bearer ' })

		await expectLoggedOut(res)
		expect(await redisClient.exists(refreshKey)).toBe(0)
	})

	/*
	 * The guard's other side, and it IS reachable over real HTTP: an Authorization header can carry
	 * an explicit empty value. `authorization: ''` arrives as the defined empty string — distinct
	 * from the header being absent, which the guard above refuses outright.
	 * `.replace('Bearer ', '')` on `''` still returns `''`, so `accessToken !== ''` is
	 * false and the access-token lookup is skipped outright; the refresh half of logout still runs.
	 */
	it('skips the access-token lookup outright when the Authorization header is present but empty', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		await seedRefreshSession(refreshKey)

		const res = await callLogout({ cookie: signedCookie(refresh), authorization: '' })

		await expectLoggedOut(res)
		expect(await redisClient.exists(refreshKey)).toBe(0)
	})

	// No cookie header at all: the first guard in authorizationLogoutHandler refuses before Redis is
	// ever touched.
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

	// Same guard, other half: a `.sig` that does not verify against the key set this server was
	// started with — the Redis record globalSetup seeded. Proves the signer configured in createServer
	// and the one this file's signedCookie() uses to build valid cookies are the same keys — a wrong or
	// rotated key would make every "valid" cookie in this suite fail exactly like this one.
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

		await seedRefreshSession(refreshKey)
		await seedAccessSession(accessKey)
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

	// The auth middleware is mounted app-wide and runs before the dispatch, so /health needs the same
	// pair of credentials the GraphQL endpoint does — a signed refresh cookie whose session is on the
	// cluster, and an Authorization header.
	it('serves /health to a caller carrying a real session', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		seededKeys.push(refreshKey)
		await seedRefreshSession(refreshKey)

		const res = await fetch(`${base}/health`, {
			headers: { cookie: signedCookie(refresh), authorization: 'Bearer access:xyz' }
		})

		expect(res.status).toBe(200)
		const json = (await res.json()) as { status: string; timestamp: string }
		expect(json.status).toBe('OK')
	})

	it('falls through to 404 for an unknown path', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		seededKeys.push(refreshKey)
		await seedRefreshSession(refreshKey)

		const res = await fetch(`${base}/nope`, {
			headers: { cookie: signedCookie(refresh), authorization: 'Bearer access:xyz' }
		})

		expect(res.status).toBe(404)
	})
})

/*
 * ⚠️ **B1: a `keygripRotate` must reach the verifier, not only the signer.** `ctx.cookies` reads
 * `app.keys` live, so a rotation was always visible to SIGNING; the bug was the auth middleware closing
 * over the boot-time `keys` local instead, so this same process could mint a cookie under the new key and
 * then 401 its own verification of it on the very next request. `onKeys` (src/index.mts) does exactly one
 * thing on a rotation — `app.keys = new Keygrip(...)` — so reproducing that assignment here, without a
 * live Redis pub/sub round trip, exercises precisely what a real rotation does.
 */
describe('live key rotation reaches the verifier (B1)', () => {
	// Newest first, exactly as `onKeys` builds it from a keygrip record and as `loadKeygrip` answers on
	// boot — Keygrip signs with index 0 and verifies against every entry.
	const ROTATED_MATERIAL = [Buffer.alloc(64, 7).toString('base64'), ...ITEST_KEYGRIP_KEYS.map((key) => key.material)]
	const rotatedKeys = new Keygrip(ROTATED_MATERIAL, 'sha512')

	function signedRotatedCookie(refresh: string): string {
		return `refresh_token=${refresh}; refresh_token.sig=${rotatedKeys.sign(`refresh_token=${refresh}`)}`
	}

	afterEach(() => {
		// Never leaked to a test outside this block, whether this one passed or failed.
		app.keys = keys
	})

	it('verifies a cookie signed with a key that did not exist when the process booted', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		seededKeys.push(refreshKey)
		await seedRefreshSession(refreshKey)

		// The rotation itself: the one line `onKeys` runs, reassigning `app.keys` in place.
		app.keys = rotatedKeys

		const res = await callHelloLogout({ cookie: signedRotatedCookie(refresh), authorization: 'Bearer access:xyz' })

		// Before the fix this 401'd: the middleware verified against the boot-time `keys` local, which
		// this cookie's signature does not match at any index.
		expect(res.status).toBe(200)
		const json = (await res.json()) as { data?: { helloLogout?: { txt: string } }; errors?: unknown }
		expect(json.errors).toBeUndefined()
		expect(json.data?.helloLogout).toEqual({ txt: 'Hello from helloLogout' })
	})

	// The other half of the same guarantee (ADR-034): a rotation must not log out sessions that were
	// already live. A cookie signed before the rotation still has to verify afterwards, at the older index.
	it('still verifies a cookie signed before the rotation, once the process has rotated', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		seededKeys.push(refreshKey)
		await seedRefreshSession(refreshKey)

		const preRotationCookie = signedCookie(refresh)
		app.keys = rotatedKeys

		const res = await callHelloLogout({ cookie: preRotationCookie, authorization: 'Bearer access:xyz' })

		expect(res.status).toBe(200)
		const json = (await res.json()) as { data?: { helloLogout?: { txt: string } }; errors?: unknown }
		expect(json.data?.helloLogout).toEqual({ txt: 'Hello from helloLogout' })
	})
})
