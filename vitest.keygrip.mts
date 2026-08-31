import { randomBytes } from 'node:crypto'

import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { wrapKeygripKeys } from '@axiumine/marketplace-common/encryption/wrapKeygripKeys'
import { keygripFingerprint } from '@axiumine/marketplace-common/others/keygripFingerprint'

/**
 * The keyspace the integration project runs in.
 *
 * Declared here rather than inline in `vitest.config.mts` because `globalSetup` has to write the
 * keygrip record into the *same* namespace the service under test will read it from, and those two
 * run in different processes — the project's `env` block never reaches this one. One constant, two
 * readers, no chance of seeding a prefix nobody looks at.
 */
export const ITEST_REDIS_KEY = 'marketplaceDev:itest:authenticatedLogout:'

/**
 * The signing keys the integration run works with.
 *
 * Fixed rather than random, and computed rather than written out, for two reasons. A test file that
 * signs a cookie for a booted server has to build the same `Keygrip` the server did, and importing this
 * is the only way to do that without reading the record back and unwrapping it in every suite. And a
 * value produced by `Buffer.alloc` is visibly not a key anybody minted — there is no literal here that
 * could be mistaken for one, or copied into an environment file.
 *
 * One key, not two. The array is what `Keygrip` verifies against, and a suite that seeded two would be
 * asserting nothing the single-key case does not already prove; rotation is tested elsewhere and seeds
 * its own.
 */
export const ITEST_KEYGRIP_KEYS = [
	{ id: 'itest-k1', material: Buffer.alloc(64, 42).toString('base64'), createdAt: '2026-08-12T00:00:00.000Z' }
]

/**
 * Mint a throwaway KEK and a keygrip record for the integration run (ADR-034).
 *
 * ⚠️ **Nothing boots without this.** Since ADR-034 the signing keys are a Redis record rather than two
 * environment variables, so an integration suite that only sets env starts a service that refuses to
 * start — correctly. Seeding is therefore part of provisioning the run, next to the throwaway database
 * and the throwaway CSFLE key, and for the same reason: the suite owns its secrets and destroys them
 * with the run.
 *
 * ⚠️ **The KEK is minted here and exported through `process.env`.** vitest forks its workers after
 * `globalSetup` returns, so they inherit it — the same mechanism `SEED_DEMO` already relies on. It is
 * never read from the developer's environment file: a test run must not be able to touch, or be
 * confused by, the key the real services use. Random every run, unlike the keys it wraps: nothing
 * needs to predict it, so nothing should be able to.
 */
export async function seedKeygrip(): Promise<void> {
	const kek = randomBytes(32)
	process.env.KEYGRIP_KEK = kek.toString('base64')

	await RedisConnect()
	try {
		await redisClient.hSet(`${ITEST_REDIS_KEY}keygrip`, {
			version: '1',
			wrapped: wrapKeygripKeys(ITEST_KEYGRIP_KEYS, 1, kek),
			fp: keygripFingerprint(ITEST_KEYGRIP_KEYS)
		})
	} finally {
		// This process only provisions; every test file opens its own client.
		await redisClient.close().catch(() => undefined)
	}
}
