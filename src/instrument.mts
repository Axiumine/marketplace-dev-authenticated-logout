import 'dotenv/config'

import * as Sentry from '@sentry/node'

/**
 * Sentry bootstrap. Imported through `node --import` so the SDK's instrumentation is installed before
 * any module it needs to wrap has run.
 *
 * **An empty `DSN` means no init at all** — the default in every `.env` template, and shape (A) of the
 * three the parent workspace's `SETUP.md` §7 supports. No event is built, nothing is sent, and there is
 * no transport for a certificate to be checked on. The three frontends already had this shape; the nine
 * services called `Sentry.init` unconditionally, so a service with reporting switched off still stood up
 * an SDK and a transport.
 *
 * ⚠️ **Nothing here configures TLS, and nothing here may.** Until E12-S01 this file handed `Sentry.init`
 * a `transportOptions.httpModule` that turned certificate verification off on every outbound request —
 * unconditional on environment, in all nine services, and the only outbound HTTPS these repos configure
 * themselves. A collector behind a certificate this machine does not already trust is reached by
 * **trusting its CA**, from outside the process:
 *
 * ```bash
 * NODE_EXTRA_CA_CERTS=/path/to/ca.pem yarn dev
 * ```
 *
 * Never by a boolean. A toggle travels inside a copied `.env` and downgrades a real deployment with
 * nothing failing to say so, which is why the shapes that would reintroduce one are refused by the
 * `no-restricted-syntax` block in `eslint.config.js` rather than by review.
 */
if (process.env.DSN) {
	Sentry.init({
		dsn: process.env.DSN
	})
}
