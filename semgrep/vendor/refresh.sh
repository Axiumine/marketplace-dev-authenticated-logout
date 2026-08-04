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

echo "done. review 'git diff semgrep/vendor' before committing the new snapshot."
