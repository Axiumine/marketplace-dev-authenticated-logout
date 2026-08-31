import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { GraphQLBoolean, GraphQLNonNull } from 'graphql'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so it is erased before the module would be evaluated — the deferred `import()` below is what
// keeps the module-level mutants attributable, and an erased import cannot undo that.

const del = vi.fn()
const hGetAll = vi.fn()
const hDel = vi.fn()
const incr = vi.fn()
const captureException = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { del, hGetAll, hDel, incr } }))
vi.mock('@sentry/node', () => ({ captureException }))

// Imported inside beforeAll, not at module top level: a module-level mutant (the
// `description` literal below) changes value during ESM evaluation. Importing at
// file scope runs that evaluation during Vitest's collection phase, before any
// test is active, so Stryker cannot attribute the kill to a test and reports the
// mutant as Survived even though the suite would plainly fail. Deferring the
// import to beforeAll makes the evaluation happen while a test is running.
let logout: (typeof import('../src/graphQLApi/schema/mutations/logout.mts'))['logout']

beforeAll(async () => {
	;({ logout } = await import('../src/graphQLApi/schema/mutations/logout.mts'))
})

/*
 * The one shape a session key has, and the only one still deleted: the digest of the
 * prefixed token. The second delete this resolver used to issue — the token itself, the pre-cutover shape —
 * went with the fallback that could read it, so every assertion below is a single key per half.
 *
 * The digests are written out as literals, computed elsewhere: a test that hashed the token with the call
 * the implementation makes would agree with it about any algorithm, including a mutated one.
 */
const REFRESH_DIGEST = 'c81b450d77200783f68a3ff41d8ebcbafe2bb8f27bf0458cf5800040dff84cf5'
const REFRESH_KEY = `test:${REFRESH_DIGEST}`
const ACCESS_KEY = 'test:c12bbd0040e3933bb83bdb74cbf57db678068b4d380022f9d178022289b3406e'

/*
 * What a session hash holds that this service cares about, and the index row it produces. The
 * account id and the tier come out of the hash rather than out of a constant here — this is the one
 * service shared by all three tiers, so it has no tier of its own to assume.
 */
const ACCOUNT_ID = '68a1f0c2e4b0a91234567890'
const SESSION_HASH = { _id: ACCOUNT_ID, tier: 'shopOwner' }
const INDEX_KEY = `test:idx:shopOwner:${ACCOUNT_ID}`

/*
 * The key of the access token minted beside this refresh token, as the login filed it.
 *
 * ⚠️ **A key, and one this file never derives.** It is stored whole — prefix and digest — so the resolver
 * has nothing to hash and nothing to guess, and a literal unrelated to any token in this file is exactly
 * the point: what is proved is that the resolver deletes *what the session says*, not what it can rebuild
 * from a header it may never have been given.
 *
 * The default fixture above deliberately carries no such field. A session minted before it existed has
 * none, and the resolver has to keep behaving as it did — which every other test in this file asserts.
 */
const BOUND_ACCESS_KEY = 'test:9f6d3a1c0b7e45d28c1a5f0e3b9d47a6c2e8f10b4d7a93c65e2f8a0b1d4c7e93'

// minimal ctx: the resolver only uses state.user and cookies.set
function makeCtx(user: { refreshToken?: string; accessToken?: string }) {
	return {
		state: { user },
		cookies: { set: vi.fn() }
	} as unknown as IContextLogout & { cookies: { set: ReturnType<typeof vi.fn> } }
}

describe('mutations.logout', () => {
	beforeEach(() => {
		del.mockReset()
		hDel.mockReset()
		incr.mockReset()
		captureException.mockReset()
		// The session this logout is ending, under the hashed key shape. Every test needs one: the resolver
		// reads the hash before it deletes anything, and a resolver told there is no session unfiles nothing.
		hGetAll.mockReset()
		hGetAll.mockResolvedValue(SESSION_HASH)
	})

	it('is of non-nullable Boolean type', () => {
		expect(logout.type).toBeInstanceOf(GraphQLNonNull)
		expect((logout.type as GraphQLNonNull<typeof GraphQLBoolean>).ofType).toBe(GraphQLBoolean)
	})

	it('describes itself as "logout"', () => {
		expect(logout.description).toBe('logout')
	})

	it('deletes the refresh session and empties the cookie', async () => {
		const ctx = makeCtx({ refreshToken: 'refresh:abc' })

		await expect(logout.resolve(null, {}, ctx)).resolves.toBe(true)

		expect(del.mock.calls).toEqual([[REFRESH_KEY]])
		expect(ctx.cookies.set).toHaveBeenCalledWith('refresh_token', '', expect.any(Object))
	})

	it('also deletes the access session when present', async () => {
		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: 'access:xyz' }))

		expect(del.mock.calls).toEqual([[REFRESH_KEY], [ACCESS_KEY]])
	})

	it('does not delete the access session if the token is an empty string', async () => {
		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: '' }))

		// Both refresh shapes and neither access shape — the count alone would now pass on a resolver that
		// deleted the access session under one shape and skipped the refresh one.
		expect(del.mock.calls).toEqual([[REFRESH_KEY]])
	})

	/*
	 * ⚠️ **The whole of the access-key residual, at the logout end of it.** `authorizationLogoutHandler` leaves
	 * `accessToken` unset whenever the presented token's session is already gone — the ordinary state of a
	 * tab that has not refreshed since another one did, because a rotation kills the access token it
	 * replaces. Every name this resolver could once reach for was then absent, and the *live* access token
	 * — the one the last refresh minted — outlived the logout meant to end it: in no family, in no index
	 * row, named by nothing anyone could ask for. The session records its key now, so it goes too.
	 */
	it('retires the access key the session records even when the call presented no live token', async () => {
		hGetAll.mockResolvedValue({ ...SESSION_HASH, accessKey: BOUND_ACCESS_KEY })

		await expect(logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc' }))).resolves.toBe(true)

		expect(del.mock.calls).toEqual([[REFRESH_KEY], [BOUND_ACCESS_KEY]])
	})

	// A header naming a *different* access token than the session does — an older one, presented by a tab
	// that has not refreshed since. Both are this session's, so both go: following only one leaves the
	// other alive, and which one that is depends on which tab happened to send the logout.
	it('retires both the bound access key and a presented token that names another', async () => {
		hGetAll.mockResolvedValue({ ...SESSION_HASH, accessKey: BOUND_ACCESS_KEY })

		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: 'access:xyz' }))

		expect(del.mock.calls).toEqual([[REFRESH_KEY], [ACCESS_KEY], [BOUND_ACCESS_KEY]])
	})

	// The ordinary logout: the header names the very token the session recorded. One name, one delete —
	// the `Set` is what keeps this path from paying a third round trip on every logout on the platform.
	it('issues no extra delete when the bound key and the presented token name the same session', async () => {
		hGetAll.mockResolvedValue({ ...SESSION_HASH, accessKey: ACCESS_KEY })

		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: 'access:xyz' }))

		expect(del.mock.calls).toEqual([[REFRESH_KEY], [ACCESS_KEY]])
	})

	// An empty field would delete the bare prefix — the key nothing owns and everything on this platform
	// is stored under a suffix of. Guarded for the same reason the empty access token above is.
	it('deletes nothing extra when the session records an empty access key', async () => {
		hGetAll.mockResolvedValue({ ...SESSION_HASH, accessKey: '' })

		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc' }))

		expect(del.mock.calls).toEqual([[REFRESH_KEY]])
	})

	/*
	 * ⚠️ **The read comes first and the unfiling comes last, and neither position is free.** The hash is
	 * deleted by the same resolver, so anything it has to say about the account has to be asked for before
	 * that; and unfiling before the delete would leave a still-usable refresh token listed nowhere for the
	 * width of the window between the two calls, which is precisely when a revocation would miss it.
	 */
	it('unfiles the session from its account index, once the keys it names are gone', async () => {
		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc' }))

		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(REFRESH_KEY)
		expect(hDel.mock.calls).toEqual([[INDEX_KEY, REFRESH_DIGEST]])
		expect(hGetAll.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...del.mock.invocationCallOrder))
		expect(hDel.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...del.mock.invocationCallOrder))
	})

	/*
	 * A session minted before the index existed carries no tier and no `_id`, and was never filed
	 * under anything. The fields are checked rather than assumed because the alternative is not a harmless
	 * miss: `undefined` reaches a template as the word `undefined`, so the unguarded call would delete a
	 * field from `test:idx:undefined:undefined` — a key one future writer away from being real.
	 */
	it.each([
		['no tier at all', { _id: ACCOUNT_ID }],
		['a tier no collection mints', { _id: ACCOUNT_ID, tier: 'root' }],
		['no account id', { tier: 'shopOwner' }],
		['nothing at all — the key missed', {}]
	])('unfiles nothing when the session hash carries %s', async (_label, hash) => {
		hGetAll.mockResolvedValue(hash)

		await expect(logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc' }))).resolves.toBe(true)

		// The keys still go: a session that is not in the index is still a session being ended.
		expect(del.mock.calls).toEqual([[REFRESH_KEY]])
		expect(hDel).not.toHaveBeenCalled()
	})

	it('swallows Redis errors, sends them to Sentry and still returns true', async () => {
		del.mockRejectedValueOnce(new Error('redis down'))

		await expect(logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc' }))).resolves.toBe(true)

		expect(captureException).toHaveBeenCalledTimes(1)
		expect(captureException.mock.calls[0][0]).toBeInstanceOf(Error)
	})
})

describe('MutationsApi', () => {
	// Imported fresh inside the test, not via the shared beforeAll above: the
	// `name: 'MutationsApi'` literal and the object literal it lives in are
	// asserted eagerly by graphql-js (assertName) the moment GraphQLObjectType is
	// constructed, so a mutant that blanks either one makes THIS import throw.
	// Sharing that import with other tests via a beforeAll would turn the throw
	// into a hook failure — Vitest marks every test in the hook's scope "skipped",
	// not "failed", and Stryker only counts a "failed" test as a kill. An import
	// inside the test body fails only this test, which Stryker does attribute.
	it('mounts logout as its only field', async () => {
		const { default: MutationsApi } = await import('../src/graphQLApi/schema/mutations.mts')

		expect(MutationsApi.name).toBe('MutationsApi')
		expect(Object.keys(MutationsApi.getFields())).toEqual(['logout'])
	})
})
