import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { start } from '../../src/index.mts'
import { ITEST_REDIS_KEY } from '../../vitest.keygrip.mts'

/*
 * The other half of ADR-034's boot gate: no record at all, rather than a record this process cannot open.
 *
 * Two failures, two tests, because they need two different fixes and the message has to say which. A
 * missing record means nobody has minted a key set yet — or Redis was flushed — and the operator runs the
 * seed script; a mismatched KEK (keygripFailure.itest.mts) means a key set exists and THIS service is the
 * one that is wrong. A boot log that conflated them would send an operator to edit an environment file
 * that is already correct.
 *
 * ⚠️ The record is not deleted to produce this. The suite's own record is shared by every file in the
 * project, and a test that removed it would leave the run's remaining files booting against a fleet with
 * no keys — the failure would look like this test's own subject and be blamed on the wrong thing. Pointing
 * REDIS_KEY at an empty namespace under the same ACL-granted stem asks the same question and touches
 * nothing: `keygripKey()` reads the prefix at call time, so this is exactly the "record has not been
 * seeded here" case, seen from a service that is otherwise perfectly configured.
 */
describe('start() when no keygrip record has been seeded', () => {
	const realRedisKey = process.env.REDIS_KEY

	afterAll(async () => {
		process.env.REDIS_KEY = realRedisKey
		await redisClient.close().catch(() => undefined)
	})

	it('names the seed command, tears down Redis, and exits 1', async () => {
		process.env.REDIS_KEY = `${ITEST_REDIS_KEY}nokeygrip:`

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			await expect(start()).resolves.toBeUndefined()

			// The message an operator reads at 3am. It names the key that is empty and the command that
			// fills it, because "missing" without a next step is a message that costs an outage.
			const [, error] = errorLog.mock.calls.find(([label]) => label === 'error') as [string, Error]
			expect(error.message).toMatch(/^KEYGRIP_RECORD_MISSING: no keygrip key set at "/)
			expect(error.message).toContain('yarn seed:keygrip')

			expect(exit).toHaveBeenCalledWith(1)

			// ⚠️ Nothing is left running. Redis had come up — loadKeygrip runs after the connect — so this
			// proves the teardown covers the half-booted process, not just the one that never connected.
			// This service holds no MongoDB connection at all: sessions live in Redis and nothing else does.
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
			errorLog.mockRestore()
		}
	})
})
