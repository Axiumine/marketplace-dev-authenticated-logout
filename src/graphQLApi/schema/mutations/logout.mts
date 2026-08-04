import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { refreshTokenOptions } from '@axiumine/koa-utils/lib/tokenOptions'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'
import { GraphQLBoolean, GraphQLNonNull } from 'graphql'

dotenv.config()

export const logout = {
	description: 'logout',
	type: new GraphQLNonNull(GraphQLBoolean),
	async resolve(_: unknown, {}, ctx: IContextLogout) {
		try {
			// delete the access token used to make this call
			// and, if it still exists, the refresh token too
			await redisClient.del(`${process.env.REDIS_KEY}${ctx.state.user.refreshToken}`)
			// The `del` above already dereferenced ctx.state.user, so an undefined user has thrown
			// into the catch by now: `?.` can never short-circuit here and the mutant that drops it
			// is equivalent.
			// Stryker disable next-line OptionalChaining: ctx.state.user is always defined here — see comment above
			if ((ctx.state.user?.accessToken || '') !== '') {
				await redisClient.del(`${process.env.REDIS_KEY}${ctx.state.user.accessToken}`)
			}

			// delete cookies
			ctx.cookies.set('refresh_token', '', refreshTokenOptions)
		} catch (e) {
			Sentry.captureException(e)
		}

		return true
	}
}
