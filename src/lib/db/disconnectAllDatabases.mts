import { RedisDisconnect } from '@axiumine/koa-utils/dataSources/Redis'
import * as Sentry from '@sentry/node'

/**
 * Disconnects from all databases and exits the process
 * @param exitCode - The exit code to use when terminating the process
 */
export async function disconnectAllDatabases(exitCode: number = 0): Promise<never> {
	const DISCONNECT_TIMEOUT = 5000 // 5 seconds timeout
	let code = exitCode

	try {
		await Promise.race([
			Promise.all([RedisDisconnect()]),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Database disconnection timeout')), DISCONNECT_TIMEOUT))
		])

		Sentry.captureMessage('All databases disconnected successfully')
	} catch (e) {
		Sentry.captureException(e, {
			extra: { detail: 'Error during database disconnection' }
		})
		code = 1
	}

	// Flushed before exit, outside the try: this is the one place every fatal path on the platform ends up
	// (`start()`'s catch, graceful shutdown), and `process.exit` below does not wait for Sentry's network
	// call — without this, the event captured above (or by whoever called this function) never leaves the
	// process. `.catch` swallows a flush failure rather than letting this already-fatal function reject
	// on it — the exit two lines down must run either way.
	await Sentry.flush(2000).catch(() => undefined)

	// Outside the try: if it stayed inside, a throw on the success branch would end up in
	// the catch above and the process would exit with 1 instead of the requested exitCode.
	process.exit(code)
}
