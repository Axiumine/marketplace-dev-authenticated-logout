# marketplace-dev-authenticated-logout

Session teardown. Port **4030**, endpoint `/logout`, one mutation — `logout` — and a `helloLogout`
liveness probe. The smallest service on the platform, and the only one **all three tiers** call.

## Why it is its own service

Every other concern is split on tier × concern: an Admin talks to Admin services, a ShopOwner to ShopOwner
services, a User to User services. Logging out is the one operation where that split buys nothing — it
deletes the Redis session and clears the cookies, and neither step needs to know which collection the
caller authenticated against. Three copies of that would be three places for a session to survive a
logout.

`authorizationLogoutHandler` is the middleware that authenticates the call; the `logout` resolver is the
seven lines that undo the session. Nothing else.

## What will bite you here

⚠️ **A tier-specific branch does not belong in this repo.** The moment `logout` needs to know the caller's
`tier`, the reason this service is shared has gone, and the work belongs in that tier's own
`*-authorization` service instead.

⚠️ **The refresh token is required, the access token is optional, and they are not symmetrical.** The
handler throws `throwPreconditionFailedNoAuthCookie` with no cookie and `throwPreconditionFailedNoAuthHeader`
with no `Authorization` header, but only the *refresh* session must still exist in Redis — a missing one is
`throwAlreadyDone`. A missing or expired **access** session is explicitly fine and simply leaves
`ctx.state.user.accessToken` unset, which is why the resolver re-tests it before the second `del`.

⚠️ **Logging out twice is an error, by design.** `throwAlreadyDone` is what a second call gets. Do not
"fix" it into a silent success: the frontends distinguish the two.

⚠️ **Seed a test session from `test/helpers/sessionFixtures.mts`, never by hand.** The handler's refresh
lookup asked for a field named `id` for as long as this service existed, and no writer has ever written
one — the refresh hash is `IRefreshData` and its identity field is `_id`. Every logout on the platform
therefore hit `throwAlreadyDone` and deleted nothing, while answering the caller with success. It survived
26 integration tests against a live Redis because each of them seeded the field the *reader* asked for
(`hSet(refreshKey, 'id', 'itest')`), so the suite agreed with the defect instead of catching it. The
fixtures are typed as `IRefreshData` / `IRedisDataUser` and shaped like what the login writers actually
write; a hand-rolled `hSet` in a new test re-opens the same hole.

⚠️ **The resolver swallows everything into Sentry and returns `true` regardless.** A Redis outage during
`del` reports a successful logout to the client while the session is still live. That is a deliberate
trade — the cookie is cleared either way — but it means this mutation's return value is not evidence the
session died.

⚠️ **Only `refresh_token` is a cookie.** The access token travels in the `Authorization` header and has no
cookie to clear. The clear reuses `refreshTokenOptions` from `koa-utils` — the same object that set it — so
the attributes match by construction; hand-writing an options literal here strands the cookie in the
browser, and `marketplace-nginx` adding `Secure` on the way out (see its `CLAUDE.md`) makes the mismatch
harder to spot locally than in production.

⚠️ **`x-introspectioncode` skips the whole authentication block.** It exists so schema introspection can
run without a session; it means a request carrying that header reaches the resolver with `ctx.state` unset.
The resolver's context type says so — `state.user` is optional there and required in `IContextLogout`, and
the gap is deliberate: the shared type is right for the services whose middleware always fills it
and wrong for this one. A resolver here that assumes a session is a resolver that throws on that path.

## Related files

| Topic | File |
|---|---|
| rules for agents working in this repo | [`CLAUDE.md`](./CLAUDE.md) |
| git hooks, gate order, node selection | [`REPO.md`](./REPO.md) |
| the whole platform — tiers, ports, terminology | parent [`CLAUDE.md`](./CLAUDE.md) |
| the edge and the `Secure` cookie rewrite | parent [`marketplace-nginx/CLAUDE.md`](https://github.com/Axiumine/marketplace-nginx/blob/main/CLAUDE.md) |

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
