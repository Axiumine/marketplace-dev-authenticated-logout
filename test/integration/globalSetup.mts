import { seedKeygrip } from '../../vitest.keygrip.mts'

/**
 * Provision the integration run before any worker forks.
 *
 * ⚠️ This service holds no database, so unlike the four MongoDB-backed services there is no throwaway
 * database to drop and no migrations to replay here — the only thing the run needs provisioned is the
 * keygrip record, and it needs it badly: since ADR-034 `start()` reads the cookie-signing keys from
 * Redis and refuses to boot without them, so a suite that skipped this would watch every test fail on a
 * service that correctly declined to start.
 *
 * `globalSetup` rather than a `setupFiles` entry, for two reasons. It runs once for the whole project
 * instead of once per file, which is what a shared Redis record wants; and it runs BEFORE vitest forks
 * its workers, so the `KEYGRIP_KEK` that `seedKeygrip` mints is inherited by every one of them. A
 * `setupFiles` module runs inside an already-forked worker and could not hand the key to the others.
 */
export async function setup(): Promise<void> {
	await seedKeygrip()
}
