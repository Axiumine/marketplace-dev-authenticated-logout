import { randomBytes } from 'node:crypto'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { start } from '../../src/index.mts'

/*
 * The boot gate of ADR-034, against the real record in the real Redis.
 *
 * The whole point of moving the signing keys out of five environment files is that a service holding
 * the wrong key STOPS instead of starting and signing cookies its siblings cannot verify. That is a
 * property of the boot sequence, not of loadKeygrip — which is unit-tested against a fake store in
 * marketplace-common — so it is asserted here, where a real record written by globalSetup meets a
 * process that cannot open it.
 *
 * Its own file for the reason startFailure.itest.mts is: it needs a process with nothing connected
 * yet, and vitest gives each test file its own module registry, so the Redis singleton this closes on
 * the way out is not one another file is using.
 */
describe('start() when the KEK does not open the keygrip record', () => {
	const realKek = process.env.KEYGRIP_KEK

	afterAll(async () => {
		process.env.KEYGRIP_KEK = realKek
		await redisClient.close().catch(() => undefined)
	})

	it('logs the mismatch, tears down Redis, and exits 1', async () => {
		// Well-formed and 32 bytes, so the length guard passes and the failure is the one being tested:
		// the record's tag does not verify under this key.
		process.env.KEYGRIP_KEK = randomBytes(32).toString('base64')

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			await expect(start()).resolves.toBeUndefined()

			// The message an operator reads at 3am. It names the failure and the record, and — deliberately
			// — no key material: this line goes to a boot log.
			const [, error] = errorLog.mock.calls.find(([label]) => label === 'error') as [string, Error]
			expect(error.message).toMatch(/^KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 1 \(\w{12}\)\./)

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
