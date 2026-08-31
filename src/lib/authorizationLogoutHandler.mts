import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { IContextRefresh } from '@axiumine/koa-utils/graphQL/schema/context/IContextRefresh'
import { throwAlreadyDone } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyDone'
import { throwPreconditionFailedNoAuthCookie } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthCookie'
import { throwPreconditionFailedNoAuthHeader } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthHeader'
import { verifySignedRefreshToken } from '@axiumine/koa-utils/koa/middleware/authenticatedAuthorizationHandler/verifySignedRefreshToken'
import { constantTimeEquals } from '@axiumine/marketplace-common/others/constantTimeEquals'
import { isIntrospectionBypassAllowed } from '@axiumine/marketplace-common/others/isIntrospectionBypassAllowed'
import { readSessionField } from '@axiumine/marketplace-common/others/sessionKeys'
import * as dotenv from 'dotenv'
import Keygrip from 'keygrip'
import { Next } from 'koa'

dotenv.config()

export const authorizationLogoutHandler = (keys: Keygrip) => async (ctx: IContextLogout, next: Next) => {
	/***************************
	 * CLIENT: sends the opaque token
	 * - in authorization: ctx.request.header.authorization =  'Bearer TOKEN_HERE
	 * - in cookie: ctx.request.header.cookie = cookie_name=TOKEN_HERE
	 */
	/*if (typeof ctx.request.header?.operation !== 'undefined') {
          const operationName = ctx.request.header.operation
          console.debug('[authorizationHandler] operationName: ', operationName)
      }*/
	let introspection = false

	// refresh
	const cookie = ctx.request.header?.cookie // refresh
	if (typeof cookie === 'undefined') {
		// ⚠️ The environment gate is evaluated **before** the code is read. Outside `development`
		// and `test` the bypass does not exist at all, and a caller sending the correct header gets exactly
		// the error a caller sending nothing gets — a wrong code and a disabled feature must not be
		// distinguishable from the outside. `INTROSPECTION_CODE` stays in REQUIRED_ENV_VARS regardless:
		// unset, it stringifies to the literal `'undefined'`, and that word would be the bypass.
		//
		// This handler checks twice, once here for the cookie and once below for the Authorization header,
		// and both checks are gated: a request carrying neither is exactly the shape the bypass admits.
		//
		// Both comparisons are `constantTimeEquals`, never `===`: string equality stops at the first
		// differing character, and that gradient is a working oracle for the configured value.
		if (
			isIntrospectionBypassAllowed() &&
			typeof ctx.request.header !== 'undefined' &&
			constantTimeEquals(ctx.request.header['x-introspectioncode'], `${process.env.INTROSPECTION_CODE}`)
		) {
			introspection = true
		} else {
			throw throwPreconditionFailedNoAuthCookie()
		}
	}

	// Reaching this line means the cookie block above did not throw, and both of its exits
	// (cookie present, or introspection accepted) require ctx.request.header to be defined.
	// The `?.` and the `typeof … !== 'undefined'` guard below are therefore dead by construction:
	// mutants that strip them are equivalent, so they are excluded from the mutation score
	// rather than chased with a test that cannot exist. Keep them for symmetry with the block above.
	// Stryker disable next-line OptionalChaining: ctx.request.header is always defined here — see comment above
	const authorization = ctx.request.header?.authorization // access
	if (typeof authorization === 'undefined') {
		// Gated as well, and not redundantly: the caller this second check answers is one that *did* send a
		// cookie and no `Authorization` header, so the block above let it through and this is the only place
		// its code is read. Outside the allowlist it gets `throwPreconditionFailedNoAuthHeader`, the same
		// error as a caller that sent no code at all.
		if (
			isIntrospectionBypassAllowed() &&
			// Stryker disable next-line ConditionalExpression,StringLiteral: always true here — see comment above
			typeof ctx.request.header !== 'undefined' &&
			constantTimeEquals(ctx.request.header['x-introspectioncode'], `${process.env.INTROSPECTION_CODE}`)
		) {
			introspection = true
		} else {
			throw throwPreconditionFailedNoAuthHeader()
		}
	}

	if (!introspection) {
		const refreshToken = verifySignedRefreshToken(ctx as unknown as IContextRefresh, keys)
		// Keyed by the digest of the token, and by nothing else since the raw-key fallback was removed.
		// This service is the one that must never miss: a logout that cannot find the session answers
		// `throwAlreadyDone` and leaves a live credential behind after telling the user they are out.
		//
		// ⚠️ **`_id`, and the name is the whole defect.** This read asked for `id` for as long as
		// the service existed, and no writer has ever written that field: the refresh hash is `IRefreshData`,
		// whose identity field is `_id` — written by the three login writers and by `refreshSessionTokens`.
		// `hGet` therefore returned `null` for every real session, this handler took the branch below, and
		// **every logout on the platform answered `throwAlreadyDone` while both tokens stayed live** until
		// their natural expiry. The field name is asserted against a writer-shaped hash in
		// `test/authorizationLogoutHandler.test.mts`, not against whatever this line happens to ask for —
		// seeding the read's own field name is exactly how the defect survived its own test suite.
		const redRefreshSession = await readSessionField(redisClient, refreshToken, '_id')
		if (redRefreshSession != null) {
			ctx.state = {
				user: {
					refreshToken: refreshToken
				}
			}
		} else {
			throw throwAlreadyDone()
		}

		// Access Token, optional
		const accessToken = authorization!.replace('Bearer ', '')
		if (accessToken !== '') {
			const redAccessSession = await readSessionField(redisClient, accessToken, '_id') // 'access:' already present
			if (redAccessSession != null) {
				ctx.state.user.accessToken = accessToken
			} // else no problem, session could be expired
		}
	} // else introspection
	return next()
}
