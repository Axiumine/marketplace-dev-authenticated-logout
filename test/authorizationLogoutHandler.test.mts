import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import Keygrip from 'keygrip'
import type { Next } from 'koa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hGet = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGet } }))

const { authorizationLogoutHandler } = await import('../src/lib/authorizationLogoutHandler.mts')

const keys = new Keygrip(['test-key-1', 'test-key-2'], 'sha512', 'base64')
const REFRESH = '27119032-9043-4a9f-bd4c-9d06fd576290'

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

	it('rejects a cookie with an invalid signature', async () => {
		const ctx = makeCtx({
			cookie: `refresh_token=${REFRESH}; refresh_token.sig=fake-signature`,
			authorization: 'Bearer access:xyz'
		})

		await expect(authorizationLogoutHandler(keys)(ctx, next)).rejects.toThrow()
		expect(hGet).not.toHaveBeenCalled()
	})

	it('bypasses the checks with a valid x-introspectioncode and never touches Redis', async () => {
		const ctx = makeCtx({ 'x-introspectioncode': 'test-introspection-code' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(hGet).not.toHaveBeenCalled()
		expect(next).toHaveBeenCalledTimes(1)
	})

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

	it('fills state.user with both tokens when the sessions exist', async () => {
		hGet.mockResolvedValueOnce('refresh-session-id').mockResolvedValueOnce('access-session-id')
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer access:xyz' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).resolves.toBe('next')

		expect(hGet).toHaveBeenNthCalledWith(1, `test:refresh:${REFRESH}`, 'id')
		expect(hGet).toHaveBeenNthCalledWith(2, 'test:access:xyz', '_id')
		expect(ctx.state.user).toEqual({ refreshToken: `refresh:${REFRESH}`, accessToken: 'access:xyz' })
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
		expect(hGet).toHaveBeenCalledTimes(1)
	})

	it('rejects if the refresh session no longer exists in Redis', async () => {
		hGet.mockResolvedValueOnce(null)
		const ctx = makeCtx({ cookie: signedCookie(), authorization: 'Bearer access:xyz' })

		await expect(authorizationLogoutHandler(keys)(ctx, next)).rejects.toThrow()
		expect(next).not.toHaveBeenCalled()
	})
	/*
	 * E13-S11, and twice over: this handler consults the code once for the cookie and once for the
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
