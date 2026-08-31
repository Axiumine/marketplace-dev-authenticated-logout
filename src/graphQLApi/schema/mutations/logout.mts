import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import type { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { refreshTokenOptions } from '@axiumine/koa-utils/lib/tokenOptions'
import { deleteSession, readSessionHash, sessionKey, unindexSession } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'
import { GraphQLBoolean, GraphQLNonNull } from 'graphql'

dotenv.config()

/*
 * ⚠️ **`state.user` is always here, and `IContextLogout` says so.** Apollo hands the resolver the raw Koa
 * `ctx` (`src/index.mts:171-178`), and the only way to this line is through `authorizationLogoutHandler`,
 * which either fills `state.user` from a session it found in Redis or throws before any resolver runs.
 * The file once carried a locally widened `user?:` context type for a request that arrived authenticated by
 * nothing; no such request exists.
 */
export const logout = {
	description: 'logout',
	type: new GraphQLNonNull(GraphQLBoolean),
	async resolve(_: unknown, {}, ctx: IContextLogout) {
		const user = ctx.state.user

		try {
			// Read before the delete, because the delete is what makes it unreadable: the session hash is the
			// only thing on the platform that knows which account this token belongs to. This service is
			// tier-agnostic on purpose — one logout for all three tiers — so it learns the tier the same way,
			// from the session itself rather than from a constant of its own.
			const session = { ...(await readSessionHash(redisClient, user.refreshToken)) }

			// delete the access token used to make this call
			// and, if it still exists, the refresh token too
			// ⚠️ One key shape now. This used to delete two, because a session being revoked could
			// predate the cutover; nothing on the platform can read that shape any more, so a second
			// delete would be a round trip per logout against a key that cannot exist.
			await deleteSession(redisClient, user.refreshToken)

			// ⚠️ **After the delete, never before.** Unfiled first, a still-usable refresh token is
			// listed nowhere for the width of the window between the two calls, and a revocation running in it
			// misses the session entirely. This order can only leave a row naming a key that is already gone,
			// and the field's own TTL removes that row even if this call never runs.
			//
			// Both fields are checked rather than assumed: `indexSession` writes an `_id` and a tier into every
			// row it creates, so a hash carrying neither was never indexed — a session minted before the index existed,
			// or the empty hash `readSessionHash` answers on a miss. Passing the string
			// `'undefined'` on into a key name would build `idx:undefined:undefined` and delete from it.
			const tier = Object.values(TIER).find((known) => known === session.tier)
			if (tier !== undefined && session._id !== undefined) {
				await unindexSession(redisClient, user.refreshToken, { _id: session._id, tier })
			}
			/*
			 * The access half goes by **both** of the names anything here can know it by, deduped.
			 *
			 * The header's, when the call carried one: `authorizationLogoutHandler` sets `accessToken` only
			 * when a header arrived *and* its session was still in Redis. Both halves of the guard are
			 * load-bearing — `undefined` reaches the key builder as the literal `'undefined'` and would
			 * delete `<prefix>undefined`, and the empty string would delete the bare prefix.
			 *
			 * ⚠️ **And the session's own, which is not always the same one.** `accessToken` is unset whenever
			 * the presented token's session is no longer on the cluster — the ordinary state of a tab that
			 * has not refreshed since another one did, since a rotation kills the access token it replaces.
			 * The header then names a key that is already gone while the *live* access token, the one the
			 * last refresh minted, is named by nothing this resolver could ask for: it is in no family, in
			 * no index row, and it outlived the logout by up to ninety-one minutes. The user has been told
			 * they are out, and that is not what being out means. This one is a *key* rather than a token,
			 * so it is already built; it is absent on a session minted before the field existed, where
			 * there is nothing to retire.
			 *
			 * One single-key `del` each, never a multi-key one: these digests land in different cluster
			 * slots (BCON-08). The `Set` is what keeps the ordinary logout — where the header names exactly
			 * the key the session records — at one delete instead of two.
			 */
			const accessKeysToRetire = new Set<string>()

			if (user.accessToken !== undefined && user.accessToken !== '') {
				accessKeysToRetire.add(sessionKey(user.accessToken))
			}
			if (session.accessKey !== undefined && session.accessKey !== '') {
				accessKeysToRetire.add(session.accessKey)
			}

			await Promise.all([...accessKeysToRetire].map((key) => redisClient.del(key)))

			// delete cookies
			ctx.cookies.set('refresh_token', '', refreshTokenOptions)
		} catch (e) {
			Sentry.captureException(e)
		}

		return true
	}
}
