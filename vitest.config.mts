import { defineConfig } from 'vitest/config'

import { ITEST_REDIS_KEY } from './vitest.keygrip.mts'
import { nodeNextResolver } from './vitest.shared.mts'

// graphql throws "Duplicate graphql modules / from another realm" when a transformed copy
// (inlined by vitest) and a native copy (externalized in node_modules) meet — which happens
// the moment the real ApolloServer validates the schema. Inlining the whole graphql/Apollo
// chain keeps a single transformed instance across index.mts and Apollo. dedupe pins the path.
// koa-utils and marketplace-common must stay on the SAME side of this boundary. Both throw
// GraphQLErrors that koa-utils' tryCatchRethrow narrows with `instanceof`; split across the
// boundary they carry different graphql copies, the instanceof is false, and a 401 answers as
// 500 "Internal Server Error" — a failure that exists only under vitest, since plain node
// resolves both to one copy.
const inlineDeps = [/graphql/, /@apollo\/server/, /@as-integrations/, /@axiumine\/koa-utils/, /@axiumine\/marketplace-common/]

// Two projects, one aggregated coverage report (must reach 100% — see COVERAGE.md):
//   - unit:        Redis mocked, fast, no datasource needed.
//   - integration: boots the real server against the real Redis cluster (REDIS_* from
//                  .env via the sources' own dotenv.config()); only the keyspace prefix
//                  is pinned to an isolated, ACL-allowed namespace and PORT=0 is ephemeral.
export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		server: { deps: { inline: inlineDeps } },
		coverage: {
			provider: 'v8',
			// ⚠️ `include` is what makes the thresholds below mean anything, and it is not
			// optional. Without it the v8 provider reports only the files a test actually imported:
			// a source file no suite ever loads is ABSENT from the report rather than listed at 0%,
			// so a 100% gate passes over it (RISK_REGISTER R07). The glob names every shipped source
			// file, so a new one is force-listed at 0% and takes the run red until it has a test.
			//
			// ⚠️ `all: true` and `extension: ['.mts']` used to sit either side of this line and did
			// nothing at all. vitest 4 removed both from CoverageOptions, no runtime path reads them,
			// and an unchecked spread swallowed them without a warning — so the safety net a reader
			// took them for was never there. Do not bring either back: a non-null `include` is the
			// entire mechanism, and `all` is not a synonym for it.
			include: ['src/**/*.mts'],
			reporter: ['text', 'text-summary', 'html', 'lcov'],
			// 100% on every metric. If a run drops below, add tests or delete dead code until it
			// returns to 100% — never lower these numbers. See COVERAGE.md.
			thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }
		},
		projects: [
			{
				plugins: [nodeNextResolver],
				resolve: { dedupe: ['graphql'] },
				test: {
					name: 'unit',
					include: ['test/*.test.mts'],
					server: { deps: { inline: inlineDeps } },
					// Caps how long a test's full name may be — the mutation gate selects tests by name, and
					// past a size it cannot; see vitest.testNames.mts.
					setupFiles: ['./vitest.testNames.mts'],
					// Set before the sources run `dotenv.config()` — dotenv does not override existing
					// process.env keys, so these win over whatever the local `.env` holds.
					env: {
						NODE_ENV: 'test',
						REDIS_KEY: 'test:'
					}
				}
			},
			{
				plugins: [nodeNextResolver],
				resolve: { dedupe: ['graphql'] },
				test: {
					name: 'integration',
					include: ['test/integration/*.itest.mts'],
					server: { deps: { inline: inlineDeps } },
					// Caps how long a test's full name may be — the mutation gate selects tests by name, and
					// past a size it cannot; see vitest.testNames.mts.
					setupFiles: ['./vitest.testNames.mts'],
					// Redis connection params (hosts/user/password/cluster flag) come from .env; the overrides
					// below are pinned: per-service keyspace and ephemeral port.
					//
					// REDIS_KEY carries the service name as a third segment so all seven services' integration
					// suites can run at the same time. They used to share `marketplaceDev:itest:`, which meant a
					// platform-wide run had to be serialised: two suites at once see each other's session keys
					// and drain each other's cleanup lists. The `marketplaceDev:itest:` stem is kept because the
					// Redis ACL grants the test user exactly that pattern — a new top-level prefix would be
					// denied. `fileParallelism: false` below is a different axis and still required: files
					// inside one service share its throwaway database.
					// ⚠️ Seeds the keygrip record and mints the KEK the workers inherit (ADR-034). Without it
					// start() refuses to boot, correctly, and every file in the project fails.
					globalSetup: ['./test/integration/globalSetup.mts'],
					env: {
						NODE_ENV: 'test',
						// ⚠️ Imported, not written here: globalSetup writes the keygrip record into this
						// namespace from a different process, and a prefix typed twice is a prefix that can be
						// edited once.
						REDIS_KEY: ITEST_REDIS_KEY,
						PORT: '0'
					},
					fileParallelism: false,
					testTimeout: 30000,
					hookTimeout: 30000
				}
			}
		]
	}
})
