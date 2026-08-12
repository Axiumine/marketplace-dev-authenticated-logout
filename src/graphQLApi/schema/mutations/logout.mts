import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { refreshTokenOptions } from '@axiumine/koa-utils/lib/tokenOptions'
import { deleteSession } from '@axiumine/marketplace-common/others/sessionKeys'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'
import { GraphQLBoolean, GraphQLNonNull } from 'graphql'

dotenv.config()

/*
 * ⚠️ **What reaches this resolver is not an `IContextLogout`, and E15-S09 is the story of pretending it was.**
 * `IContextLogout` declares `state.user` as always present. Apollo hands the resolver the raw Koa `ctx`
 * (`src/index.mts:171-178`), and `authorizationLogoutHandler` fills `state.user` on the authenticated path
 * only: a request admitted by the `x-introspectioncode` bypass skips that whole block and arrives here with
 * `ctx.state` still Koa's empty default. The declared type made the absent case unrepresentable, so the code
 * that handled it anyway — `ctx.state.user?.accessToken` — sat *after* a dereference of the same object that
 * had already thrown. Unreachable by construction, therefore unkillable, therefore carried by a Stryker
 * exclusion instead of by a test. Widening the type is what deletes the exclusion: `user` is optional here
 * because it genuinely is, and the one branch that reads it is now an ordinary tested branch.
 *
 * `IContextLogout` lives in `@axiumine/koa-utils`, published and shared with services whose middleware does
 * always fill `state.user` — the narrowing is correct there and wrong only here, which is why this widening
 * is local rather than a change to that package.
 */
export type IContextLogoutResolver = Omit<IContextLogout, 'state'> & {
	state: { user?: IContextLogout['state']['user'] }
}

export const logout = {
	description: 'logout',
	type: new GraphQLNonNull(GraphQLBoolean),
	async resolve(_: unknown, {}, ctx: IContextLogoutResolver) {
		const user = ctx.state.user
		// No session on the context means the introspection bypass let this call in without authenticating it,
		// so there is nothing to end and no cookie of ours to clear. The answer is the `true` this mutation
		// has always given such a call — it used to arrive via a TypeError reported to Sentry on the way.
		if (user === undefined) {
			return true
		}

		try {
			// delete the access token used to make this call
			// and, if it still exists, the refresh token too
			// ⚠️ Both key shapes go, every time (E13-S02). The session being revoked may predate the cutover,
			// and deleting only the shape this deploy writes would leave the credential alive under the other
			// one — a logout that leaves the session usable is worse than none, the user has been told they
			// are out.
			await deleteSession(redisClient, user.refreshToken)
			// The access token is optional on the session this service writes: `authorizationLogoutHandler`
			// sets it only when the header carried one *and* its session was still in Redis. Both halves are
			// load-bearing — `undefined` reaches the key builder as the literal `'undefined'` and would delete
			// `<prefix>undefined`, and the empty string would delete the bare prefix.
			if (user.accessToken !== undefined && user.accessToken !== '') {
				await deleteSession(redisClient, user.accessToken)
			}

			// delete cookies
			ctx.cookies.set('refresh_token', '', refreshTokenOptions)
		} catch (e) {
			Sentry.captureException(e)
		}

		return true
	}
}
