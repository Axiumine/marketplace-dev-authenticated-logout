import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { refreshTokenOptions } from '@axiumine/koa-utils/lib/tokenOptions'
import { deleteSession } from '@axiumine/marketplace-common/others/sessionKeys'
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
			// ⚠️ Both key shapes go, every time (E13-S02). The session being revoked may predate the cutover,
			// and deleting only the shape this deploy writes would leave the credential alive under the other
			// one — a logout that leaves the session usable is worse than none, the user has been told they
			// are out.
			await deleteSession(redisClient, ctx.state.user.refreshToken)
			// The `deleteSession` above already dereferenced ctx.state.user, so an undefined user has thrown
			// into the catch by now: `?.` can never short-circuit here and the mutant that drops it
			// is equivalent.
			// Stryker disable next-line OptionalChaining: ctx.state.user is always defined here — see comment above
			if ((ctx.state.user?.accessToken || '') !== '') {
				// Sound: the guard above is exactly `accessToken` being a non-empty string. The template literal
				// this replaced accepted `undefined` silently and would have deleted the key `<prefix>undefined`.
				await deleteSession(redisClient, ctx.state.user.accessToken!)
			}

			// delete cookies
			ctx.cookies.set('refresh_token', '', refreshTokenOptions)
		} catch (e) {
			Sentry.captureException(e)
		}

		return true
	}
}
