import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { GraphQLBoolean, GraphQLNonNull } from 'graphql'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const del = vi.fn()
const captureException = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { del } }))
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
 * The two shapes every session key now has (E13-S01/S02): the digest of the prefixed token, which is what
 * writes use, and the token itself, which is what everything wrote before the cutover. Both are deleted on
 * every logout — the session being revoked may predate the cutover, and dropping only one shape would leave
 * a usable credential behind after the user has been told they are out.
 *
 * The digests are written out as literals, computed elsewhere: a test that hashed the token with the call
 * the implementation makes would agree with it about any algorithm, including a mutated one.
 */
const REFRESH_KEY = 'test:c81b450d77200783f68a3ff41d8ebcbafe2bb8f27bf0458cf5800040dff84cf5'
const ACCESS_KEY = 'test:c12bbd0040e3933bb83bdb74cbf57db678068b4d380022f9d178022289b3406e'

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
		captureException.mockReset()
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

		expect(del.mock.calls).toEqual([[REFRESH_KEY], ['test:refresh:abc']])
		expect(ctx.cookies.set).toHaveBeenCalledWith('refresh_token', '', expect.any(Object))
	})

	it('also deletes the access session when present', async () => {
		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: 'access:xyz' }))

		expect(del.mock.calls).toEqual([[REFRESH_KEY], ['test:refresh:abc'], [ACCESS_KEY], ['test:access:xyz']])
	})

	it('does not delete the access session if the token is an empty string', async () => {
		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: '' }))

		// Both refresh shapes and neither access shape — the count alone would now pass on a resolver that
		// deleted the access session under one shape and skipped the refresh one.
		expect(del.mock.calls).toEqual([[REFRESH_KEY], ['test:refresh:abc']])
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
