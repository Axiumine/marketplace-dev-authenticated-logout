import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { IContextRefresh } from '@axiumine/koa-utils/graphQL/schema/context/IContextRefresh'
import { throwAlreadyDone } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyDone'
import { throwPreconditionFailedNoAuthCookie } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthCookie'
import { throwPreconditionFailedNoAuthHeader } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthHeader'
import { verifySignedRefreshToken } from '@axiumine/koa-utils/koa/middleware/authenticatedAuthorizationHandler/verifySignedRefreshToken'
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
	// refresh
	const cookie = ctx.request.header?.cookie // refresh
	if (typeof cookie === 'undefined') {
		throw throwPreconditionFailedNoAuthCookie()
	}

	// Reaching this line means the cookie block above did not throw, and its one exit requires
	// ctx.request.header to be defined. The `?.` below is therefore dead by construction: a mutant
	// that strips it is equivalent, so it is excluded from the mutation score rather than chased with
	// a test that cannot exist. Keep it for symmetry with the read above.
	// Stryker disable next-line OptionalChaining: ctx.request.header is always defined here — see comment above
	const authorization = ctx.request.header?.authorization // access
	if (typeof authorization === 'undefined') {
		throw throwPreconditionFailedNoAuthHeader()
	}

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
	const accessToken = authorization.replace('Bearer ', '')
	if (accessToken !== '') {
		const redAccessSession = await readSessionField(redisClient, accessToken, '_id') // 'access:' already present
		if (redAccessSession != null) {
			ctx.state.user.accessToken = accessToken
		} // else no problem, session could be expired
	}
	return next()
}
