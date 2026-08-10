import 'dotenv/config'

import { sentryBeforeSend } from '@axiumine/marketplace-common/others/sentryBeforeSend'
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
 *
 * ⚠️ **The SDK's blanket PII flag is absent rather than `false`** (E12-S03), so there is no character to
 * flip. It resolves to `httpBodies: ["incomingRequest", …]`, every request on this platform is a GraphQL
 * POST, and the attached body is therefore the envelope — which on
 * `marketplace-dev-admin-authenticated-resource` carries `adminUpdatePwd`'s `passwordOld` / `passwordNew`
 * in plaintext, and on the ShopOwner surface carries the `personalData` that ADR-029 encrypts at rest.
 * Attaching bodies would defeat that encryption from the observability layer. The decision and its two
 * reasons are recorded in the observability section of `docs/architecture.md`; the key itself is refused
 * by the `no-restricted-syntax` block, so this comment is the only place it is described rather than
 * named.
 *
 * ⚠️ **`dataCollection` names every category, and it must.** `resolveDataCollectionOptions.js` chooses
 * its base as `options.dataCollection != null ? DEFAULTS : defaultPiiToCollectionOptions(…)`, and
 * `DEFAULTS` is the fully permissive set — so supplying the option *at all* flips the base from the
 * restrictive branch to the permissive one and **an omitted category is an enabled category**. A short
 * `dataCollection` carrying only the keys being turned off would read like a tightening while switching
 * request bodies, cookies and unfiltered headers on. Every key is written out for that reason, and the
 * arrival of a new one in a future release is caught by E12-S05's version guard.
 *
 * `beforeSend` is not made redundant by any of this. `httpServerSpansIntegration` writes the client
 * address straight onto the server span, outside the `dataCollection` machinery entirely, where it is
 * reached by no option here and by neither value of the removed flag — only the scrubber takes it back
 * out. The SDK's own `SENSITIVE_KEY_SNIPPETS` filtering is a second layer and a minor-version
 * implementation detail, never a reason to shorten the scrubber's list.
 */
if (process.env.DSN) {
	Sentry.init({
		dsn: process.env.DSN,
		dataCollection: {
			// The client address is a network-derived value this platform does not capture (E12-S06); this
			// is the switch that stops the SDK inferring one from the forwarding headers for `event.user`.
			userInfo: false,
			cookies: false,
			httpHeaders: { request: false, response: false },
			// `[]` is the documented "collect no bodies" value. An omitted key would collect all four.
			httpBodies: [],
			urlQueryParams: false,
			// The document keeps its literal values redacted at collection time, so the query shape, the
			// transaction name and the stack still arrive and nothing needed for debugging is lost. The
			// variables are a different thing: on this surface they *are* the passwords and the personal
			// data, which is what the envelope body would have carried.
			graphQL: { document: true, variables: false },
			genAI: { inputs: false, outputs: false },
			databaseQueryData: false,
			// A resolver frame can hold a decrypted document or a resolved token, and the SDK's name-based
			// filtering matches post-bundling identifiers rather than the ones written here.
			stackFrameVariables: false,
			// 7, not the DEFAULTS 5: both branches of the legacy mapping use 7 because the ContextLines
			// integration does, so this keeps stack context exactly as it is today.
			frameContextLines: 7
		},
		beforeSend: sentryBeforeSend
	})
}
