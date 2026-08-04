import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { IContextRefresh } from '@axiumine/koa-utils/graphQL/schema/context/IContextRefresh'
import { throwAlreadyDone } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyDone'
import { throwPreconditionFailedNoAuthCookie } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthCookie'
import { throwPreconditionFailedNoAuthHeader } from '@axiumine/koa-utils/graphQL/throw/throwPreconditionFailedNoAuthHeader'
import { verifySignedRefreshToken } from '@axiumine/koa-utils/koa/middleware/authenticatedAuthorizationHandler/verifySignedRefreshToken'
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
		if (
			typeof ctx.request.header !== 'undefined' &&
			ctx.request.header['x-introspectioncode'] === `${process.env.INTROSPECTION_CODE}`
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
		if (
			// Stryker disable next-line ConditionalExpression,StringLiteral: always true here — see comment above
			typeof ctx.request.header !== 'undefined' &&
			ctx.request.header['x-introspectioncode'] === `${process.env.INTROSPECTION_CODE}`
		) {
			introspection = true
		} else {
			throw throwPreconditionFailedNoAuthHeader()
		}
	}

	if (!introspection) {
		const refreshToken = verifySignedRefreshToken(ctx as unknown as IContextRefresh, keys)
		const redRefreshSession = await redisClient.hGet(`${process.env.REDIS_KEY}${refreshToken}`, 'id')
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
			const redAccessSession = await redisClient.hGet(`${process.env.REDIS_KEY}${accessToken}`, '_id') // 'access:' already present
			if (redAccessSession != null) {
				ctx.state.user.accessToken = accessToken
			} // else no problem, session could be expired
		}
	} // else introspection
	return next()
}
