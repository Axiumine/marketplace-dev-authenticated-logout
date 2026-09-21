import { readFile } from 'node:fs/promises'

import { sentryBeforeSend } from '@axiumine/marketplace-common/others/sentryBeforeSend'
import { describe, expect, it } from 'vitest'

/*
 * The guard that fires when the Sentry SDK moves under this configuration.
 *
 * Everything `src/instrument.mts` asserts about the SDK was read out of `node_modules` at 10.69.0:
 * that supplying `dataCollection` at all swaps the base for the fully permissive `DEFAULTS`, that `[]`
 * is the documented "collect no bodies" value, that `graphQL.variables` is on in both branches of the
 * legacy mapping, and that the client address is written onto the server span outside the whole
 * mechanism. None of that is a documented API contract, and the blanket PII flag the mapping starts
 * from is deprecated and removed in v11. A guard written against a moving SDK stops guarding the day
 * the dependency bumps, silently — which is the failure this test exists to make loud.
 *
 * It pins the exact version rather than the major, because one of those claims is a *minor*-version
 * detail. `SENSITIVE_KEY_SNIPPETS` is what makes an `authorization` header arrive `[Filtered]` today,
 * it lives in `@sentry/core/build/esm/utils/data-collection/filtering-snippets.js`, it is exported from
 * no public entry point, and a minor release may add to it, drop from it or move the file without
 * anything here failing. The platform must never be reduced on the strength of that list, and the
 * second case below is what proves it is not: the scrubber removes the header on its own, with no SDK
 * involved at all.
 *
 * 10.69.0 → 10.75.0 was the first bump this guard caught, and the comparison is recorded here so the
 * next one starts from something: every file the claims above rest on is byte-identical between the two
 * releases — `DEFAULTS` and the base-selection line in `resolveDataCollectionOptions`,
 * `defaultPiiToCollectionOptions`, `filtering-snippets`, core's `requestdata` integration, and
 * node-core's `httpServerIntegration`, `httpServerSpansIntegration` and `http/index`. The one change in
 * the audited surface is additive: `httpHeaders` now also accepts a boolean or an allow/deny object as
 * a shorthand for both directions, and the explicit `{ request: false, response: false }` passed here
 * still resolves through `??` to both `false`. No `dataCollection` category was added, which is the
 * change that would have mattered most — an omitted category is an enabled one.
 */

const PINNED = '10.75.0'

const MIGRATION =
	'the Sentry SDK moved off 10.75.0. Re-read `resolveDataCollectionOptions`, `httpServerSpansIntegration` and `httpServerIntegration` before trusting `src/instrument.mts`, then update the observability section of `docs/architecture.md`, which records what each `dataCollection` category replaced. v11 removes the blanket PII flag that mapping starts from. `maxIncomingRequestBodySize` defaults to `"medium"` and the default is the defect — check the name still forwards to `httpServerIntegration`s `maxRequestBodySize`, and that `include.data` on the requestdata integration is still what makes the body an event field.'

const installedVersion = async (name: string): Promise<string> => {
	const manifest = await readFile(new URL(`../node_modules/@sentry/${name}/package.json`, import.meta.url), 'utf8')

	return (JSON.parse(manifest) as { version: string }).version
}

describe('the SDK is the version every claim in instrument.mts was read from', () => {
	// `node-core` joins the two: it owns `httpServerIntegration`, where the request-body default lives and
	// where the option `src/instrument.mts` passes is really read. It ships on its own version line.
	it.each(['node', 'core', 'node-core'])('@sentry/%s is pinned to the audited version', async (name) => {
		expect(await installedVersion(name), MIGRATION).toBe(PINNED)
	})
})

describe('the scrubber owes nothing to the SDK filtering anything', () => {
	it('removes an authorization header no SDK filter ever saw', () => {
		expect(sentryBeforeSend({ request: { headers: { authorization: 'Bearer 9f2c1b7e' } } })).toStrictEqual({
			request: { headers: {} }
		})
	})

	// The second layer. `maxIncomingRequestBodySize: 'none'` is what stops the bytes being captured;
	// this is what removes them from an event that somehow carries them anyway — a hook the SDK calls with
	// a body it collected under a different option, or a default that moves on a bump.
	it('removes a request body no SDK option was asked to withhold', () => {
		expect(sentryBeforeSend({ request: { data: '{"variables":{"password":"sentinel"}}' } })).toStrictEqual({
			request: {}
		})
	})
})
