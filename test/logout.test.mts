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

		expect(del).toHaveBeenCalledTimes(1)
		expect(del).toHaveBeenCalledWith('test:refresh:abc')
		expect(ctx.cookies.set).toHaveBeenCalledWith('refresh_token', '', expect.any(Object))
	})

	it('also deletes the access session when present', async () => {
		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: 'access:xyz' }))

		expect(del).toHaveBeenCalledTimes(2)
		expect(del).toHaveBeenNthCalledWith(2, 'test:access:xyz')
	})

	it('does not delete the access session if the token is an empty string', async () => {
		await logout.resolve(null, {}, makeCtx({ refreshToken: 'refresh:abc', accessToken: '' }))

		expect(del).toHaveBeenCalledTimes(1)
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
