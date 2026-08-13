import type { IRefreshData } from '@axiumine/marketplace-common/others/IRefreshData'
import type { IRedisDataUser } from '@axiumine/marketplace-common/others/Redis/IRedisDataUser'
import { TIER } from '@axiumine/marketplace-common/others/Tier'

/*
 * ⚠️ **The two session hashes as the writers really produce them, and the reason this file exists**
 * (E15-S01).
 *
 * Every test in this service used to seed one field, named after whatever the handler asked for —
 * `hSet(refreshKey, 'id', 'itest')`. No writer on this platform has ever written an `id` field: the refresh
 * hash is `IRefreshData`, whose identity is `_id`, written by the three `setRedisLoginSession*` writers at
 * login and by `refreshSessionTokens` at every rotation. The read and its tests agreed with each other
 * about a field that did not exist, so the suite stayed green over a real Redis cluster while **every
 * logout in production answered success and left both tokens live**.
 *
 * Seeding from the written shape is what makes that impossible to repeat: a reader asking for a field no
 * writer writes now misses, and the test fails. The declarations are typed rather than plain objects so the
 * compiler carries the other half — renaming a field in `marketplace-common` breaks this file instead of
 * quietly un-pinning the reads.
 *
 * Lives under `test/helpers/` and not beside the suites: the unit project collects `test/*.test.mts` and
 * the integration project `test/integration/*.itest.mts`, so a module here is imported by both and
 * collected as neither — one fixture, three suites, no drift.
 */

/**
 * The refresh-token session hash, exactly as a login writer or a rotation writes it.
 *
 * ⚠️ `accessKey` names the access half of the pair (E14-S06) and is written by every login and every
 * rotation, so it belongs here — a fixture without it would seed a session shape the platform stopped
 * producing. The value is a plausible key that names nothing on the cluster, which is the case a suite
 * has to survive anyway: an access token expires long before its refresh token, so most of a session's
 * life is spent with this field pointing at a key that is already gone.
 */
export const REFRESH_SESSION: IRefreshData = {
	_id: '507f1f77bcf86cd799439011',
	tier: TIER.user,
	familyId: '3f2a1d9c-6b7e-4c1a-9f0d-2e5b8c4a7d13',
	originalLogin: '1754784000000',
	sessionCapDays: '30',
	accessKey: `${process.env.REDIS_KEY}5e1c7a94b0d23f68ae5c1074b9d3f2a6c8e04b17d92a5f3c6e8b0147a2d9c5f3`
}

/** The access-token session hash for a customer, as `setRedisLoginSessionUser` writes it. */
export const ACCESS_SESSION: IRedisDataUser = {
	_id: '507f1f77bcf86cd799439011',
	email: 'customer@marketplace.test',
	tier: TIER.user
}

/**
 * Either hash as Redis holds it — a flat map of strings, which is all a hash ever is.
 *
 * The cast is confined to this file so no suite has to repeat it: `IRefreshData` and `IRedisDataUser` are
 * interfaces, and an interface has no index signature to assign from.
 */
export const asHash = (session: IRefreshData | IRedisDataUser): Record<string, string> => ({
	...(session as unknown as Record<string, string>)
})

/**
 * The refresh hash with its identity field removed, and nothing else touched.
 *
 * The state that separates "this key exists" from "this session can be revoked": every field but the
 * identity one populated, `exists` answering 1, and the one lookup the logout handler makes still missing.
 */
export const refreshSessionWithoutIdentity = (): Record<string, string> => {
	const hash = asHash(REFRESH_SESSION)
	delete hash._id

	return hash
}
