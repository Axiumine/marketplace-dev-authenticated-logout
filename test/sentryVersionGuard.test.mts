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
 *
 * 10.75.0 → 10.76.2 is the second bump this guard caught, and unlike the first it is not byte-identical. Two files of the
 * audited surface changed, both for one reason: 10.75.2 wires `dataCollection.urlQueryParams` into every URL the SDK
 * collects (`event.request.url`, the server span's `url.full`, `http.url` and `http.target`, outgoing `url.query` and
 * `http.query`) through the new `filterCollectedUrl` and `filterUrlQuery` modules. They are core's `requestdata`
 * integration and node-core's `httpServerSpansIntegration`. The change only narrows: with `urlQueryParams: false` the query
 * is removed from values that 10.75.0 sent raw, and the filter falls back to the old unfiltered behaviour only when no
 * client exists. `include.query_string` can now also be forced on by an explicit `requestDataIntegration` option, which
 * no service sets. Still byte-identical: `DEFAULTS` and the base-selection line in `resolveDataCollectionOptions`,
 * `defaultPiiToCollectionOptions`, `filtering-snippets`, `types/datacollection`, `utils/request`, `filterCookies`, and
 * node-core's `httpServerIntegration` and `http/index`. No `dataCollection` category was added. `@sentry/node` pins
 * `@sentry/opentelemetry` and `@sentry/server-utils` exactly, so they move in lockstep and join the list below; the
 * `opentelemetry` change is the same URL filtering. Read from both releases' published tarballs, whose hashes match the
 * lockfile and the registry, and measured end to end (docs/report/sentry-10-76-2-url-query-capture.md).
 *
 * 10.76.2 → 10.78.0 is the third bump this guard caught, and unlike the first two nothing in the audited surface
 * changed at all. Two releases lie between the pins, 10.77.1 and 10.78.0; 10.77.0 was never published. Every file the
 * claims above rest on is byte-identical between 10.76.2 and 10.78.0, in the esm and cjs builds and in the types where
 * a file has them: `DEFAULTS` (the same hash) and the base-selection line in `resolveDataCollectionOptions`,
 * `defaultPiiToCollectionOptions`, `filtering-snippets`, `filterKeyValueData`, `filterCookies`, `filterCollectedUrl`,
 * `filterUrlQuery`, `filterQueryParams`, `types/datacollection`, `utils/request`, core's `requestdata` integration and
 * its `data: true`, core's `server-subscription` (the `"none"` test on the body size), node-core's
 * `httpServerIntegration`, `httpServerSpansIntegration` and `http/index`, and `@sentry/node`'s own
 * `integrations/http.js`, the file where `maxIncomingRequestBodySize` is renamed to `maxRequestBodySize`, which this
 * guard had not named before. No `dataCollection` category or option was added: the eleven keys of the type are the
 * same, which is the change that would have mattered most. What did change is span lifecycle, client-report accounting
 * and packaging, and none of it reads or filters a body, a header, a cookie, a client address or a query string. A
 * response that closes without finishing now ends an Express layer span with status `cancelled` (core
 * `express/patch-layer`, and server-utils' Express instrumentation); an aborted outgoing HTTP or undici request ends
 * its span without the error status; core counts dropped spans, removes one dropped-item client report from `scope`,
 * maps the metric category to `trace_metric`, drops the `previous_response_id` fallback of the OpenAI conversation id,
 * changes one SQL regex, and caps the tunnel handler at 20 MiB, a handler `src/instrument.mts` never configures. A
 * sampled-out error is now dropped before the event processors run, which cannot apply while no `sampleRate` is set.
 * node-core's ContextLines now reads only files with a source extension, so `frameContextLines: 7` can only yield less
 * context, never more, and `.mts` frames still match; its `modules` integration, in the cjs build only, now resolves
 * versions on the pnpm and Bun layouts. `@sentry/node` pins `@sentry/core`, `@sentry/node-core`,
 * `@sentry/opentelemetry` and `@sentry/server-utils` exactly, to 10.78.0 as it pinned them to 10.76.2, so all five
 * move in lockstep, as they did at 10.76.2: `opentelemetry` changed only in its version and a peer range,
 * `server-utils` only in the Express listener above. Dependency ranges tightened and no package was added or removed:
 * `@opentelemetry/api` is now `>=1.9.1 <1.10.0`, and node-core's `@opentelemetry/instrumentation` and
 * `@opentelemetry/exporter-trace-otlp-http` peers stop below 0.300.0. Read from the published tarballs of all five
 * packages at both releases; no end-to-end replay was run for this bump, so the reading is the evidence, and the
 * measurement in docs/report/sentry-10-76-2-url-query-capture.md was not repeated.
 */

const PINNED = '10.78.0'

const MIGRATION =
  'the Sentry SDK moved off 10.78.0. Re-read `resolveDataCollectionOptions`, `httpServerSpansIntegration` and `httpServerIntegration` before trusting `src/instrument.mts`, then update the observability section of `docs/architecture.md`, which records what each `dataCollection` category replaced. v11 removes the blanket PII flag that mapping starts from. `maxIncomingRequestBodySize` defaults to `"medium"` and the default is the defect — check the name still forwards to `httpServerIntegration`s `maxRequestBodySize`, and that `include.data` on the requestdata integration is still what makes the body an event field.'

const installedVersion = async (name: string): Promise<string> => {
  const manifest = await readFile(new URL(`../node_modules/@sentry/${name}/package.json`, import.meta.url), 'utf8')

  return (JSON.parse(manifest) as { version: string }).version
}

describe('the SDK is the version every claim in instrument.mts was read from', () => {
  // `node-core` joins the two: it owns `httpServerIntegration`, where the request-body default lives and
  // where the option `src/instrument.mts` passes is really read. It ships on its own version line.
  // `opentelemetry` and `server-utils` join them because `@sentry/node` pins both exactly, so they move in lockstep
  // with it and a bump that left either behind would be a mixed install.
  it.each(['node', 'core', 'node-core', 'opentelemetry', 'server-utils'])(
    '@sentry/%s is pinned to the audited version',
    async (name) => {
      expect(await installedVersion(name), MIGRATION).toBe(PINNED)
    }
  )
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
