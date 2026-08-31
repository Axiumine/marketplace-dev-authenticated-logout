import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { requiredAuthBoundaryCases } from '@axiumine/marketplace-common/others/authBoundaryContract'
import { describe, expect, it } from 'vitest'

/*
 * The contract lives in `marketplace-common` and says what every authenticated service's boundary
 * suite has to prove; this file is how *this* service answers for its share of it. Each required case is
 * carried by a `// AB-xx:` comment above the test that proves it, and the assertion below is that none of
 * them is missing — which is the check nobody could run before, because the list existed nowhere.
 *
 * Three of the eleven cases are not this service's to answer, and the contract says so in writing rather
 * than here: it serves all three tiers (ADR-005), so it asserts no tier and has no wrong one to refuse, and
 * it mints nothing, so it has no rotation to replay.
 *
 * ⚠️ **A tag is a claim, and this test cannot check the claim.** It reads comments: it catches the case
 * nobody wrote a test for, not the test that was gutted while its tag stayed. Deleting an assertion out of
 * a tagged test is still caught, by mutation testing, one gate later.
 */

// The name is the key in AUTH_BOUNDARY_SERVICES, not a description: `requiredAuthBoundaryCases` throws on
// anything it does not know, so a typo here fails the suite instead of quietly asking for no cases at all.
const SERVICE = 'marketplace-dev-authenticated-logout'

/** Every file that may carry a tag. A case proven in a file nobody listed here counts as missing. */
const SUITE_FILES = ['authorizationLogoutHandler.test.mts']

const here = dirname(fileURLToPath(import.meta.url))

const suite = SUITE_FILES.map((file) => readFileSync(join(here, file), 'utf8')).join('\n')

describe('the auth-boundary contract', () => {
	it.each(requiredAuthBoundaryCases(SERVICE).map((id) => [id]))('%s is tagged in this service’s boundary suite', (id) => {
		expect(suite).toContain(`// ${id}:`)
	})

	// The suite files are read, not globbed, so an empty read would pass every assertion above vacuously.
	it('read a boundary suite that is actually there', () => {
		expect(suite.length).toBeGreaterThan(0)
		expect(requiredAuthBoundaryCases(SERVICE).length).toBeGreaterThan(0)
	})
})
