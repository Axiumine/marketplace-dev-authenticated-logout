import 'dotenv/config'

import * as Sentry from '@sentry/node'
import type * as http from 'http'
import * as https from 'https'

// Exported so it can be unit-tested: the wrapper must disable TLS verification and
// delegate to https.request. Sentry.init below wires it in as the transport httpModule.
export const insecureHttpsModule = {
	...https,
	request: (options: https.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
		options.rejectUnauthorized = false
		return https.request(options, callback)
	}
}

Sentry.init({
	dsn: process.env.DSN,
	transportOptions: {
		httpModule: insecureHttpsModule
	}
})
