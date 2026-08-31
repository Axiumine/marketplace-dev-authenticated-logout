import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import Keygrip from 'keygrip'
import type { Next } from 'koa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ACCESS_SESSION, asHash, REFRESH_SESSION, refreshSessionWithoutIdentity } from './helpers/sessionFixtures.mts'

const hGet = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGet } }))

const { authorizationLogoutHandler } = await import('../src/lib/authorizationLogoutHandler.mts')

const keys = new Keygrip(['test-key-1', 'test-key-2'], 'sha512', 'base64')
const REFRESH = '27119032-9043-4a9f-bd4c-9d06fd576290'

/*
 * Where a session lives: the shared prefix plus the digest of the **prefixed** token. The
 * digests are written out as literals, computed elsewhere — a test that hashed the token with the call the
 * implementation makes would agree with it about any algorithm, including a mutated one.
 *
 * The raw keys below are the shape everything wrote before the cutover. Nothing builds them any
 * more — the fallback that read them is deleted — and they are kept here as the negative fixture the
 * inverted test seeds: a key that must now resolve to nothing.
 */
const REFRESH_KEY = 'test:fd62e117b7af852f29f12e502a239d1b8f31afa959d463de0368d684452cefa5'
const ACCESS_KEY = 'test:c12bbd0040e3933bb83bdb74cbf57db678068b4d380022f9d178022289b3406e'
const REFRESH_RAW_KEY = `test:refresh:${REFRESH}`
const ACCESS_RAW_KEY = 'test:access:xyz'

/*
 * Every other test in this file tells the mock what to answer; this one hands it what a session *is* — the
 * hashes `sessionFixtures.mts` builds from `IRefreshData` and `IRedisDataUser` — and makes the handler find
 * its identity inside them. See that file for why the distinction matters.
 *
 * Answers exactly as Redis would: an absent field is `null`, not `undefined`.
 */
const hGetFromWrittenSession = async (key: string, field: string) => {
	const hashes: Record<string, Record<string, string>> = {
		[REFRESH_KEY]: asHash(REFRESH_SESSION),
		[ACCESS_KEY]: asHash(ACCESS_SESSION)
	}

	return hashes[key]?.[field] ?? null
}

// Cookie signed the way Koa emits it: value + `.sig` cookie holding the Keygrip signature.
function signedCookie(token = REFRESH) {
	return `refresh_token=${token}; refresh_token.sig=${keys.sign(`refresh_token=${token}`)}`
}

function makeCtx(header?: Record<string, string>) {
	return { request: { header }, state: {} } as unknown as IContextLogout
}

// `rejects.toThrow()` is too weak here: every wrong path in this handler throws *something*
// (a GraphQLError from the throw/* helpers, or a TypeError once a guard is removed). Assert
// which precondition failed, via the `description` extension set by throwGraphQLError.
const NO_AUTH_COOKIE = 'No authorization cookie.'
const NO_AUTH_HEADER = 'No authorization header.'

function expectRejectionDescription(promise: Promise<unknown>, description: string) {
	return expect(promise).rejects.toMatchObject({
		message: 'Precondition Failed',
		extensions: { http: { status: 412 }, description }
	})
}

describe('authorizationLogoutHandler', () => {
	let next: Next

	beforeEach(() => {
		hGet.mockReset()
		next = vi.fn().mockResolvedValue('next') as unknown as Next
	})

	/*
	 * The resolution two tests below end with, written once. Both send the same request — a signed cookie
	 * and a Bearer — and both expect the same four things of a handler that found the session: it passes the
	 * request on, it reached Redis once per session and on the hashed key both times, the raw shape is never
	 * named, and both tokens land on `ctx.state.user`.
	 *
	 * What differs between the two callers is only what `hGet` was told to answer before this runs, and that
	 * stays at the call site: one hands it two ids, the other hands it the hashes a real login writes. Every
	 * assertion is still made in both cases — the helper is called, not shared setup, so a caller that
	 * skipped it would visibly assert nothing.
	 */
	const expectBothSessionsResolved = async () => {
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer access:xyz' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')

		expect(hGet.mock.calls).toEqual([
			[REFRESH_KEY, '_id'],
			[ACCESS_KEY, '_id']
		])
		expect(ctx.state.user).toEqual({ refreshToken: `refresh:${REFRESH}`, accessToken: 'access:xyz' })
	}

	// AB-04: a request carrying no credential is refused
	// AB-10: no x-introspectioncode at all leaves the ordinary refusal exactly as it is
	it('rejects the request without a cookie', async () => {
		const ctx = makeCtx({ authorization: 'Bearer access:xyz' })

		await expectRejectionDescription(authorizationLogoutHandler(keys)(ctx, next), NO_AUTH_COOKIE)
		expect(next).not.toHaveBeenCalled()
	})

	// No header object at all: the cookie guard must be the one that fires. Every mutant that
	// drops `?.` or the `typeof header !== 'undefined'` short-circuit turns this into a TypeError,
	// and every mutant that skips the cookie check lets it fall through to the *header* error.
	it('rejects with the cookie error when the request carries no headers at all', async () => {
		const ctx = makeCtx()

		await expectRejectionDescription(authorizationLogoutHandler(keys)(ctx, next), NO_AUTH_COOKIE)
		expect(hGet).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	it('rejects the request without an authorization header', async () => {
		const ctx = makeCtx({ cookie: signedCookie() })

		await expectRejectionDescription(authorizationLogoutHandler(keys)(ctx, next), NO_AUTH_HEADER)
		expect(next).not.toHaveBeenCalled()
	})

	// AB-05: a credential of the wrong shape is refused — a bad scheme, a broken signature
	it('rejects a cookie with an invalid signature', async () => {
		const ctx = makeCtx({
			cookie: `refresh_token=${REFRESH}; refresh_token.sig=fake-signature`,
			authorization: 'Bearer access:xyz'
		})

		await expect(authorizationLogoutHandler(keys)(ctx, next)).rejects.toThrow()
		expect(hGet).not.toHaveBeenCalled()
	})

	// AB-08: a valid x-introspectioncode is accepted with no credential at all, and reads no session
	it('bypasses the checks with a valid x-introspectioncode and never touches Redis', async () => {
		const ctx = makeCtx({ 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(hGet).not.toHaveBeenCalled()
		expect(next).toHaveBeenCalledTimes(1)
	})

	// AB-09: a wrong x-introspectioncode is refused
	it('ignores a wrong x-introspectioncode', async () => {
		const ctx = makeCtx({ 'x-introspectioncode': 'wrong-code' })

		await expectRejectionDescription(authorizationLogoutHandler(keys)(ctx, next), NO_AUTH_COOKIE)
	})

	// The two introspection escapes are independent: each block sets `introspection` on its own.
	// Exercising them one at a time (the other credential present) pins both assignments — a run
	// with neither credential would keep passing if only one of the two still fired.
	it('bypasses the missing cookie alone with a valid x-introspectioncode', async () => {
		const ctx = makeCtx({
			authorization: 'Bearer access:xyz',
			'x-introspectioncode': 'test-introspection-code'
		})

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(hGet).not.toHaveBeenCalled()
	})

	it('bypasses the missing authorization header alone with a valid x-introspectioncode', async () => {
		const ctx = makeCtx({ cookie: signedCookie(), 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(hGet).not.toHaveBeenCalled()
	})

	// AB-01: a valid credential is accepted and the session it resolves reaches ctx.state.user
	it('fills state.user with both tokens when the sessions exist', async () => {
		hGet.mockResolvedValueOnce('refresh-session-id').mockResolvedValueOnce('access-session-id')

		await expectBothSessionsResolved()
	})

	/*
	 * ⚠️ **The inverted raw-key test.** The fixture is unchanged — both halves of a session
	 * sitting under the pre-cutover raw keys, and nothing under either digest — and the answer flips: the
	 * handler finds no refresh session, so the logout is `throwAlreadyDone` rather than a revocation.
	 *
	 * This service is the one that used to have the strongest case for the fallback, since a logout that
	 * misses leaves a live credential behind after telling the user they are out. What removes the case is
	 * that no session of this shape can exist: the cutover was never deployed, and every writer hashes.
	 * Both raw keys are still seeded here so that a reintroduced fallback fails loudly.
	 */
	it('refuses a session written under the raw keys, and reads neither of them', async () => {
		hGet.mockImplementation(async (key: string) => (key === REFRESH_RAW_KEY || key === ACCESS_RAW_KEY ? 'session-id' : null))
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer access:xyz' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).rejects.toThrow()

		expect(hGet.mock.calls).toEqual([[REFRESH_KEY, '_id']])
		expect(next).not.toHaveBeenCalled()
	})

	it('proceeds without accessToken if the access session has already expired', async () => {
		hGet.mockResolvedValueOnce('refresh-session-id').mockResolvedValueOnce(null)
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer access:xyz' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(ctx.state.user).toEqual({ refreshToken: `refresh:${REFRESH}` })
	})

	it('does not query the access session if the Bearer is empty', async () => {
		hGet.mockResolvedValueOnce('refresh-session-id')
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer ' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(hGet.mock.calls).toEqual([[REFRESH_KEY, '_id']])
	})

	/*
	 * ⚠️ **The regression test for the `_id` read, and the only one in this file the reader cannot satisfy by
	 * agreeing with itself.** The mock answers out of `REFRESH_SESSION` and `ACCESS_SESSION` — the hashes
	 * `IRefreshData` and `IRedisDataUser` describe, which is what the four writers actually put in Redis —
	 * so the field this handler asks for has to be a field a login really writes. Ask for `id`, as this
	 * service once did, and both reads miss, `throwAlreadyDone` fires, and the assertions below
	 * fail instead of passing against a hash shaped to order.
	 *
	 */
	it('finds the session inside a hash written the way the login writers write it', async () => {
		hGet.mockImplementation(hGetFromWrittenSession)

		await expectBothSessionsResolved()
	})

	/*
	 * The same hash, minus the one field the handler reads. `tier`, `familyId`, `originalLogin` and
	 * `sessionCapDays` are all still there, so the key exists and `hGetAll` would return a session — and
	 * the logout still refuses, because a hash without an identity is not one this service can revoke.
	 * This is the failure the platform was living with: found for every other purpose, invisible to logout.
	 */
	it('refuses a refresh hash that carries every field except the identity', async () => {
		const withoutIdentity = refreshSessionWithoutIdentity()

		hGet.mockImplementation(async (key: string, field: string) =>
			key === REFRESH_KEY ? (withoutIdentity[field] ?? null) : null
		)
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer access:xyz' })

		// 204 with an empty message and description — `throwAlreadyDone`, the answer a second logout gets.
		// Asserted rather than a bare `toThrow()`: every wrong path in this handler throws something.
		await expect(authorizationLogoutHandler(keys)(ctx, next)).rejects.toMatchObject({
			extensions: { http: { status: 204 } }
		})
		expect(next).not.toHaveBeenCalled()
	})

	// AB-06: a credential whose session is gone from Redis is refused
	it('rejects if the refresh session no longer exists in Redis', async () => {
		hGet.mockResolvedValueOnce(null)
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer access:xyz' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).rejects.toThrow()
		expect(next).not.toHaveBeenCalled()
	})
	/*
	 * The environment gate, and twice over: this handler consults the code once for the cookie and once for the
	 * `Authorization` header, so both checks are gated and both are asserted. Outside `development` and
	 * `test` the code is never read, and each site refuses with the precondition it was already
	 * refusing with — a caller cannot tell a wrong code from a disabled feature.
	 */
	describe('outside the environment allowlist', () => {
		afterEach(() => {
			vi.unstubAllEnvs()
		})

		// Every value below is admitted by the `NODE_ENV !== 'production'` form this gate replaced, and
		// each is a shape a real deploy produces: a container runtime that exports nothing, a shell that
		// exports an empty string, a capital letter, a staging box nobody ever classified.
		// AB-11: a valid x-introspectioncode is refused outside the environment allowlist, indistinguishably from none
		it.each([['production'], ['staging'], ['Production'], [''], [undefined]])(
			'refuses the cookie bypass under NODE_ENV=%o, with the missing-cookie error',
			async (environment) => {
				vi.stubEnv('NODE_ENV', environment)

				const ctx = makeCtx({ authorization: 'Bearer access:xyz', 'x-introspectioncode': 'test-introspection-code' })

				await expectRejectionDescription(authorizationLogoutHandler(keys)(ctx, next), NO_AUTH_COOKIE)
				expect(hGet).not.toHaveBeenCalled()
				expect(next).not.toHaveBeenCalled()
			}
		)

		// The second site, reached only by a caller that *did* send a cookie: the block above let it
		// through, so this is the one place its code would have been read.
		it.each([['production'], ['staging'], ['Production'], [''], [undefined]])(
			'refuses the header bypass under NODE_ENV=%o, with the missing-header error',
			async (environment) => {
				vi.stubEnv('NODE_ENV', environment)

				const ctx = makeCtx({ cookie: signedCookie(), 'x-introspectioncode': 'test-introspection-code' })

				await expectRejectionDescription(authorizationLogoutHandler(keys)(ctx, next), NO_AUTH_HEADER)
				expect(hGet).not.toHaveBeenCalled()
				expect(next).not.toHaveBeenCalled()
			}
		)

		// ⚠️ Both refusals are the ones a caller sending no code at all gets, status and description
		// included: an error of the gate's own would confirm that the code was right.
		it('refuses each site with the error a request carrying no code gets', async () => {
			vi.stubEnv('NODE_ENV', 'production')

			await expectRejectionDescription(
				authorizationLogoutHandler(keys)(makeCtx({ authorization: 'Bearer access:xyz' }), next),
				NO_AUTH_COOKIE
			)
			await expectRejectionDescription(
				authorizationLogoutHandler(keys)(makeCtx({ cookie: signedCookie() }), next),
				NO_AUTH_HEADER
			)
		})
	})
})
