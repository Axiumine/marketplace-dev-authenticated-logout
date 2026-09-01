import { ApolloServer } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { koaMiddleware as apolloServerKoa } from '@as-integrations/koa'
import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { IContextLogout } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogout'
import { tdwKoaErrorHandler } from '@axiumine/koa-utils/koa/tdwKoaErrorHandler'
import type { EnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import { assertEnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import { IKeygripKeyMaterial } from '@axiumine/marketplace-common/others/IKeygripKeyMaterial'
import { loadKeygrip } from '@axiumine/marketplace-common/others/loadKeygrip'
import { watchKeygrip } from '@axiumine/marketplace-common/others/watchKeygrip'
import { authorizationLogoutHandler } from '@lib/authorizationLogoutHandler.mjs'
import { disconnectAllDatabases } from '@lib/db/disconnectAllDatabases.mjs'
import * as Sentry from '@sentry/node'
import { GraphQLSchema, NoSchemaIntrospectionCustomRule, ValidationRule } from 'graphql'
import depthLimit from 'graphql-depth-limit'
import http from 'http'
import Keygrip from 'keygrip'
import Koa, { Context, Next } from 'koa'
import bodyParserKoa from 'koa-bodyparser'

import MutationsPublic from './graphQLApi/schema/mutations.mjs'
import QueriesPublic from './graphQLApi/schema/queries.mjs'

export const ENDPOINT = '/logout'

/**
 * How this service names itself in the keygrip holders table (ADR-034).
 *
 * ⚠️ It is the repository name, spelled out rather than derived from anything: the table is read by an
 * admin deciding whether all five signing-key holders agree, and a row labelled from `process.title`
 * or from a package field would rename itself the day either changes, silently orphaning the old row.
 */
export const SERVICE_NAME = 'marketplace-dev-authenticated-logout'

// `DSN` is deliberately NOT in this list. Sentry is optional: `Sentry.init({ dsn: undefined })` is a
// no-op, so a missing telemetry credential must never stop the service from serving. Requiring it made
// boot fail *silently* — checkRequiredEnv() runs outside start()'s try, so the throw reached only the
// top-level `.catch`, which reports to the very Sentry client the missing DSN had just disabled.
export const REQUIRED_ENV_VARS = [
	'PORT',
	// ADR-034. The signing keys themselves are no longer here: they live in one Redis record shared by
	// the five services that sign cookies, and this is the key that unwraps it. A service whose KEK
	// does not open the record refuses to boot rather than signing cookies its siblings cannot verify.
	'KEYGRIP_KEK',
	'REDIS_IS_CLUSTER',
	'REDIS_DB1_HOST',
	'REDIS_DB2_HOST',
	'REDIS_DB3_HOST',
	'REDIS_DB1_PORT',
	'REDIS_DB2_PORT',
	'REDIS_DB3_PORT',
	'REDIS_USERNAME',
	'REDIS_PASSWORD',
	// No MONGODB_URI here: this service connects Redis only.
	'REDIS_KEY'
]

/**
 * The *kind* of value each name must hold, checked by `assertEnvShape` after the presence loop above.
 * Presence and shape are two passes on purpose: a name may be shaped without being required, which is
 * what lets `REDIS_URL` appear here and in no list.
 *
 * ⚠️ **A name absent from this map is unconstrained, and several are deliberately absent.**
 * `REDIS_USERNAME` and `REDIS_PASSWORD` are free strings — a credential has no format, and a rule
 * invented for one would refuse a legal password. `KEYGRIP_KEK` is left out because its length rule
 * belongs to `readKek`, the single decode site: a second spelling of it here is the drift that comment
 * exists to prevent.
 *
 * What this catches is an environment filled in from somewhere else — a Mongo URI in the Redis slot,
 * `true` where koa-utils compares against `'1'`, a host name carrying a scheme, a port with a typo in
 * it. All four are truthy, so the loop above passes every one of them. A plausible wrong value of the
 * right shape still passes and always will, because no check this process runs knows what the rest of
 * the fleet was pointed at: that residual is the open half of `RISK_REGISTER` R04.
 */
export const ENV_SHAPES: Readonly<Record<string, EnvShape>> = {
	PORT: 'port',
	REDIS_IS_CLUSTER: 'flag01',
	/*
	 * ⚠️ Shaped here and required nowhere. Its presence rule is the conditional at the foot of
	 * `checkRequiredEnv`, because the cluster branch never reads it and the committed `env` template ships
	 * it empty — a shape pass that also demanded presence would refuse the very machines this workspace
	 * ships configured. `assertEnvShape` skips an absent or empty value for exactly this case.
	 */
	REDIS_URL: 'redisUrl',
	REDIS_DB1_HOST: 'hostname',
	REDIS_DB2_HOST: 'hostname',
	REDIS_DB3_HOST: 'hostname',
	REDIS_DB1_PORT: 'port',
	REDIS_DB2_PORT: 'port',
	REDIS_DB3_PORT: 'port',
	REDIS_KEY: 'keyPrefix'
}

/**
 * Fail fast if any required environment variable is missing.
 */
export function checkRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const envVar of REQUIRED_ENV_VARS) {
		if (!env[envVar]) {
			const message = `Missing required environment variable: ${envVar}`
			throw new Error(message)
		}
	}

	/*
	 * ⚠️ **`REDIS_URL` is required on the single-node branch and on that branch only**, which is why it is checked
	 * here instead of being listed above. `REDIS_IS_CLUSTER=1` builds the cluster client out of the three
	 * `REDIS_DB*` pairs and never reads it — the committed `env` template ships it empty for exactly that reason,
	 * so a flat entry in the list would refuse the boot of a machine that is configured correctly.
	 *
	 * Any other value takes the `createClient({ url: resolveRedisUrl(REDIS_URL) })` branch, where node-redis
	 * answers an unset url with its own default of `redis://localhost:6379`. Empty is not an error there: the
	 * service connects to whatever happens to listen on this machine, writes every session into it and reports
	 * itself healthy, which is a wrong-but-populated environment nothing downstream can tell from a right one
	 * (`RISK_REGISTER` R04). `SETUP.md` puts a fresh machine on precisely that branch.
	 */
	if (env.REDIS_IS_CLUSTER !== '1' && !env.REDIS_URL) throw new Error('Missing required environment variable: REDIS_URL')

	/*
	 * Shape last, and only once every name that must be present is. A value that is absent is a
	 * different fault from a value that is the wrong kind of thing, and reporting the second while the
	 * first is outstanding sends an admin to fix a variable they have not written yet.
	 */
	assertEnvShape(ENV_SHAPES, env)
}

/**
 * Production hardens the schema: no introspection and a query-depth cap.
 * Everywhere else the rules are empty so the playground/tooling stays usable.
 */
export function buildValidationRules(env: NodeJS.ProcessEnv = process.env): ValidationRule[] {
	return env.NODE_ENV === 'production' ? [NoSchemaIntrospectionCustomRule, depthLimit(10)] : []
}

/**
 * Body of the /health endpoint. Kept pure so it is trivially testable — it cannot
 * throw, which is why the old try/catch around it was removed as dead code.
 */
export function healthResponse(): { status: string; timestamp: string } {
	return { status: 'OK', timestamp: new Date().toISOString() }
}

/**
 * Log the listening banner; in production also mirror it to Sentry as an info event.
 */
export function logListening(env: NodeJS.ProcessEnv = process.env): void {
	const message = `Serving http://*:${env.PORT}${ENDPOINT} for ${env.NODE_ENV}.`
	if (env.NODE_ENV === 'production') Sentry.captureMessage(message, 'info')
	console.info(message)
}

/**
 * Drain Apollo, close the HTTP server, then disconnect the datasources and exit.
 */
export const gracefulShutdown = async (signal: string, apolloServer: ApolloServer, httpServer: http.Server) => {
	Sentry.captureMessage(`${signal} received, shutting down gracefully...`)
	await apolloServer.stop()
	httpServer.close(() => disconnectAllDatabases(0))
}

export function onUnhandledRejection(reason: unknown): void {
	Sentry.captureException(reason)
	process.exit(1)
}

export function onUncaughtException(error: unknown): void {
	Sentry.captureException(error)
	process.exit(1)
}

/**
 * Build the Koa app + Apollo + HTTP server and start Apollo, WITHOUT connecting the
 * datasources or listening. Returned handles let callers (and tests) drive the server.
 *
 * ⚠️ The keys arrive as a parameter because they come from Redis (ADR-034), and reading Redis is
 * `start()`'s job — a server builder that fetched its own keys could not be built by a test without a
 * live datasource, and could not be handed a second key set when a rotation lands.
 */
export async function createServer(keygripKeys: IKeygripKeyMaterial[]) {
	/****************
	 * KOA
	 */
	const app = new Koa()
	// app.use(logger()) // useful only for log time to console
	app.use(tdwKoaErrorHandler)

	/*****
	 * sign cookie
	 *
	 * An SHA-512 key is used for HMAC operations. The minimum length for an SHA-512 HMAC key is 64 bytes.
	 * 64-byte base64: minted by the seed script in marketplace-db-setup, never by hand and never here.
	 *
	 * ⚠️ **Order is load-bearing.** `Keygrip` signs with index 0 and verifies against every entry, so the
	 * newest key must come first — which is how `loadKeygrip` answers — and the older ones are what keep
	 * already-issued cookies verifying across a rotation. The `cookies` package re-signs a cookie whose
	 * match came from a later index, so sessions migrate to the new key on their own.
	 */
	const keys = new Keygrip(
		keygripKeys.map((key) => key.material),
		'sha512'
	)
	app.keys = keys

	app.use(async (ctx: IContextLogout, next: Next) => {
		await authorizationLogoutHandler(keys)(ctx, next)
	})

	app.use(
		bodyParserKoa({
			enableTypes: ['json', 'form', 'text'],
			// Exclude multipart requests that graphqlUploadKoa will handle
			extendTypes: {
				json: ['application/json']
			}
		})
	) // also needed by Apollo

	/****************
	 * KOA ENDPOINT
	 */
	app.use(async (ctx: Context, next: Next) => {
		if (ctx.path === ENDPOINT) {
			// @ts-expect-error TS2769: No overload matches this call.
			const middleware = apolloServerKoa(apolloServer, {
				async context() {
					return ctx
				}
			})
			return middleware(ctx, next)
		} else if (ctx.path === '/health') {
			ctx.body = healthResponse()
			ctx.status = 200
			return
		} else {
			await next()
		}
	})

	/****************
	 * APOLLO
	 */
	const httpServer = http.createServer(app.callback())

	const graphQLSchema = new GraphQLSchema({
		query: QueriesPublic,
		mutation: MutationsPublic
	})

	const apolloServer = new ApolloServer({
		schema: graphQLSchema,
		plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
		validationRules: buildValidationRules(),
		csrfPrevention: true
	})

	await apolloServer.start()

	return { app, httpServer, apolloServer, keys }
}

/**
 * Full boot: validate env, connect the datasources, build the server and listen.
 * Returns the handles on success; on failure disconnects and exits.
 */
export async function start() {
	checkRequiredEnv()

	try {
		/****************
		 * DB
		 */
		await Promise.all([RedisConnect()])

		/****************
		 * Cookie signing keys (ADR-034)
		 *
		 * Immediately after the Redis connect and before anything can sign: the keys are one record shared
		 * by every service that issues or reads a session cookie, and a service that cannot unwrap it must
		 * not start. Five copies of the key in five environment files, with nothing comparing them, is the
		 * arrangement this replaces — its failure mode was users being logged out by whichever service the
		 * edge happened to pick.
		 */
		const { keys: keygripKeys, version, fp } = await loadKeygrip(redisClient, SERVICE_NAME)

		const { app, httpServer, apolloServer } = await createServer(keygripKeys)

		/****************
		 * Live key adoption (ADR-034)
		 *
		 * The half that makes rotation an admin action rather than a deploy: when the record moves, this
		 * process rebuilds its `Keygrip` in place. Without it the new key would reach this service only at
		 * the next restart, and the platform would spend that window signing with two different index-0
		 * keys — the failure the record was introduced to end.
		 *
		 * ⚠️ **A second connection, and it must be one.** node-redis refuses ordinary commands on a client
		 * in subscriber mode, so subscribing on the shared client would break every session read this
		 * service makes. `duplicate()` inherits the cluster's options and credentials; only `connect()` is
		 * ours to call.
		 *
		 * ⚠️ **Before `listen()`, deliberately.** Nothing may be signed with keys this process is not yet
		 * watching: a rotation landing between the build and the subscribe would be missed by both paths —
		 * the message arrives at nobody and the poll starts from a version that is already stale.
		 *
		 * `app.keys` is reassigned rather than the `Keygrip` being mutated: the instance is private to
		 * `cookies`, which reads `app.keys` per request, so a swapped reference is picked up by the next
		 * request and every in-flight one finishes against the array it started with.
		 */
		const keygripSubscriber = redisClient.duplicate()
		await keygripSubscriber.connect()

		const keygripWatch = await watchKeygrip({
			store: redisClient,
			subscriber: keygripSubscriber,
			serviceName: SERVICE_NAME,
			version,
			fp,
			onKeys: (record) => {
				app.keys = new Keygrip(
					record.keys.map((key) => key.material),
					'sha512'
				)
			},
			onError: (error) => Sentry.captureException(error)
		})

		/****************
		 * START SERVER
		 */
		await new Promise<void>((resolve) => {
			httpServer.listen(
				{
					port: process.env.PORT
					// No host: bind every interface on purpose. This used to pass a hostname key, which is not
					// a net.Server.listen option — Node ignored it and bound the unspecified address anyway, so
					// HOSTNAME never had any effect. Binding wide is the intent; the dead key only hid it.
				},
				() => {
					logListening()
					resolve()
				}
			)
		})

		// `app` travels out with the handles because it is where a rotation lands: everything that reads
		// the effect of `onKeys` — a test, or a future health probe reporting which fingerprint this
		// process is signing with — reads `app.keys`. The watch and its connection are returned for the
		// tests that have to shut a booted service down cleanly; the process itself never stops watching,
		// and `disconnectAllDatabases` ends with `process.exit`, which takes the subscriber with it.
		return { app, httpServer, apolloServer, keygripWatch, keygripSubscriber }
	} catch (error) {
		console.error('error', error)
		Sentry.captureException(error) // @fixme does not send the log, verify!
		await disconnectAllDatabases(1)
	}
}

/* v8 ignore start -- entrypoint wiring: executes only as the real process, never under test (NODE_ENV=test) */
if (process.env.NODE_ENV !== 'test') {
	// Handle unhandled promise rejections / uncaught exceptions
	process.on('unhandledRejection', onUnhandledRejection)
	process.on('uncaughtException', onUncaughtException)

	start()
		.then((srv) => {
			if (srv) {
				// Handle termination signals once the server is up
				process.on('SIGTERM', () => gracefulShutdown('SIGTERM', srv.apolloServer, srv.httpServer))
				process.on('SIGINT', () => gracefulShutdown('SIGINT', srv.apolloServer, srv.httpServer))
			}
		})
		.catch((e: unknown) => {
			/*
			 * ⚠️ The exit code is the whole point, and it used to be **0**. `checkRequiredEnv()` throws
			 * outside `start()`'s own try, so a missing variable lands here rather than in the
			 * disconnect-and-exit inside it — and this handler ended with a Sentry call and nothing else.
			 * Node then ran out of work and left with a success code: a service that never bound its port
			 * reported a clean shutdown to Docker, to systemd and to any restart policy reading `$?`, so a
			 * boot that failed was indistinguishable from one that was asked to stop. Sentry cannot stand in
			 * for the code either — with no DSN configured the SDK discards the event, which is the state
			 * this platform boots in. Say it where the container's own logs are, then leave with 1.
			 */
			console.error('fatal: the service could not start', e)
			Sentry.captureException(e)
			process.exit(1)
		})
}
/* v8 ignore stop */
