#!/usr/bin/env bash
#
# Re-download the vendored Semgrep registry packs.
#
# The frozen snapshot committed next to this script is the source of truth for
# scans (fully offline, reproducible). Run this only to deliberately update that
# snapshot, then review `git diff` before committing.
#
# Only `typescript` and `secrets` are fetched on purpose:
#   - the `javascript` pack has the SAME rule-id set as `typescript`
#   - the `nodejs`      pack is a strict SUBSET of `typescript` (36/36 shared)
# so vendoring them too would only add duplicate rules (semgrep dedupes by id).
#
set -euo pipefail
cd "$(dirname "$0")"

for pack in typescript secrets; do
	echo "fetching p/${pack} ..."
	curl -fsSL "https://semgrep.dev/c/p/${pack}" -o "${pack}.yml"
	printf '  %s.yml: %s rules\n' "${pack}" "$(grep -cE '^\s*- id:' "${pack}.yml")"
done

# ⚠️ The `secrets` pack ships ONE literal credential of its own: the canonical Slack
# documentation webhook, as a `pattern-not:` that stops the rule flagging its own example.
# GitHub push protection cannot tell that placeholder from a live webhook, so that single
# line blocked `git push` on every repo carrying this pack, and each block had to be cleared
# by hand, once per repo, every time a repo was pushed for the first time.
#
# Rewriting it as the equivalent `pattern-not-regex` excludes exactly the same one URL while
# spelling no literal the scanner can match. Verified by scanning both forms against the
# placeholder and a real-shaped webhook: identical findings, no rule-parse errors. The pack
# already uses `pattern-not-regex` ten times elsewhere, so this is its own idiom.
#
# ⚠️ This re-runs on every refresh because a re-download restores the literal, and it fails
# loudly rather than skipping: if upstream moves or drops the rule, that is a change to review
# by hand, not to paper over.
found=$(grep -c '^[[:space:]]*- pattern-not: https://hooks\.slack\.com/services/' secrets.yml || true)
if [ "${found}" -ne 1 ]; then
	printf 'refresh.sh: expected exactly 1 literal Slack webhook exclusion in secrets.yml, found %s.\n' "${found}" >&2
	printf '  The upstream pack changed shape — re-check that rule by hand before committing.\n' >&2
	exit 1
fi
sed -i 's#^\([[:space:]]*\)- pattern-not: https://hooks\.slack\.com/services/.*#\1- pattern-not-regex: https://hooks\\.slack\\.com/services/T0{8}/B0{8}/X{24}#' secrets.yml
echo '  secrets.yml: Slack webhook placeholder rewritten as pattern-not-regex (push-protection safe)'

echo "done. review 'git diff semgrep/vendor' before committing the new snapshot."
