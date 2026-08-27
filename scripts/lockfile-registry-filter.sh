#!/usr/bin/env bash
#
# Git clean/smudge filter keeping yarn.lock registry-agnostic in history.
#
#   clean  (worktree -> git)  local mirror -> public npm registry
#   smudge (git -> worktree)  public npm registry -> local mirror
#
# ⚠️ OPT-IN, and off unless a machine asks for it. With no mirror recorded every
# path below is a passthrough: a plain clone installs from registry.npmjs.org and
# its yarn.lock keeps the public URLs, on the first install and on every one
# after it. Opting in is whatever already points yarn at the mirror — a `registry`
# line in the gitignored .yarnrc, `yarn config set registry`, `--registry` on the
# command line. There is no second switch to set: `install` below reads the host
# out of yarn itself.
#
# Yarn 1 writes ABSOLUTE tarball URLs into `resolved`, so installing through a
# mirror puts its host into every line of the lockfile — and a committed lockfile
# naming a host that resolves on one network only breaks `yarn install` for every
# clone that is not on it. The published package is not affected
# (`files: ["dist"]` keeps yarn.lock out of the tarball); clones are.

set -euo pipefail

PUBLIC='https://registry.npmjs.org/'
CONFIG_KEY='yarnlock-registry.mirror'

# The mirror host, or empty when this machine has not opted in.
#
# Read from .git/config rather than from yarn, even though yarn is what supplies
# it at install time. git runs clean and smudge as its own subprocesses, from
# whichever shell happened to touch the file — a checkout from an IDE, a `git add`
# from a hook, a rebase — and none of those carry yarn's environment. Gating on it
# would make the rewrite depend on who triggered the checkout, and the two
# directions disagreeing is precisely the state that puts a LAN host into a public
# lockfile. .git/config is per-clone and git never clones it, so it holds the
# choice exactly as long as it should.
configured_mirror() {
	git config --get "$CONFIG_KEY" 2> /dev/null || true
}

# Registries every clone can reach. Yarn 1 defaults to registry.yarnpkg.com, npm
# and this repo's committed lockfile use registry.npmjs.org; both are the public
# registry, so neither is a mirror and neither needs rewriting.
is_public() {
	case "${1%/}" in
		'https://registry.npmjs.org' | 'https://registry.yarnpkg.com') return 0 ;;
		*) return 1 ;;
	esac
}

# Escape regex metacharacters so hosts with dots match literally.
escape() { printf '%s' "$1" | sed 's/[.[\*^$\/]/\\&/g'; }

case "${1:-}" in
	clean)
		MIRROR="$(configured_mirror)"
		[ -n "$MIRROR" ] || exec cat
		sed "s#$(escape "$MIRROR")#${PUBLIC}#g"
		;;
	smudge)
		MIRROR="$(configured_mirror)"
		[ -n "$MIRROR" ] || exec cat
		sed "s#$(escape "$PUBLIC")#${MIRROR}#g"
		;;
	install)
		git rev-parse --git-dir > /dev/null 2>&1 || exit 0

		# What yarn actually resolves against, straight from yarn: it exports the
		# effective registry to every script it runs, and this one runs as
		# prepare -> hooks:install. That value already folds in .yarnrc, ~/.yarnrc
		# and a --registry flag, so it also catches a mirror configured globally,
		# which a repo-local switch never could — and a mirror the filter does not
		# know about is exactly what puts a LAN host in the index.
		#
		# Empty means yarn is not the caller (someone ran this script by hand): no
		# information, so no opinion — leave whatever is recorded alone.
		YARN_REGISTRY="${npm_config_registry:-}"
		RECORDED="$(configured_mirror)"

		if [ -n "$YARN_REGISTRY" ] && is_public "$YARN_REGISTRY"; then
			# yarn installs from the public registry, so a mirror recorded earlier is
			# stale — and a stale record is worse than none: smudge would keep writing
			# a host into yarn.lock that nothing fetches from any more, and yarn would
			# then try those dead URLs on the next install. Tear it down instead.
			if [ -n "$RECORDED" ]; then
				exec "$0" uninstall
			fi
			exit 0
		fi

		MIRROR="${YARN_REGISTRY:-$RECORDED}"

		# The default, and the only behaviour a fresh clone ever sees: no filter
		# configured, nothing rewritten, installs straight from the public registry.
		[ -n "$MIRROR" ] || exit 0

		# yarn.lock holds `<registry><path>`, so the recorded host must end in the
		# separator. `registry "http://host:4873"` in a .yarnrc is valid and common.
		case "$MIRROR" in
			*/) ;;
			*) MIRROR="$MIRROR/" ;;
		esac

		# Changing mirrors: the worktree lockfile still names the OLD host, and the
		# smudge below only ever rewrites public -> mirror, so it would leave those
		# lines untouched while `clean` learned to strip the new host only. The old
		# host would then survive into the index and the pre-commit gate. Normalise
		# it away first, while the host that put it there is still recorded.
		if [ -n "$RECORDED" ] && [ "$RECORDED" != "$MIRROR" ] && [ -f yarn.lock ]; then
			tmp="$(mktemp)"
			if sed "s#$(escape "$RECORDED")#${PUBLIC}#g" < yarn.lock > "$tmp"; then
				mv "$tmp" yarn.lock
			else
				rm -f "$tmp"
			fi
		fi

		git config "$CONFIG_KEY" "$MIRROR"
		git config filter.yarnlock-registry.clean "./scripts/lockfile-registry-filter.sh clean"
		git config filter.yarnlock-registry.smudge "./scripts/lockfile-registry-filter.sh smudge"
		# Never mark the filter required: a missing script must degrade to
		# passthrough rather than break checkout.
		git config filter.yarnlock-registry.required false

		# Reconcile the existing checkout. A fresh clone lands the public URLs
		# before this filter is configured, and git will not re-smudge a file it
		# already considers up to date — so rewrite it once, here. No-op when
		# yarn.lock already points at the mirror.
		if [ -f yarn.lock ]; then
			tmp="$(mktemp)"
			if "$0" smudge < yarn.lock > "$tmp"; then
				mv "$tmp" yarn.lock
			else
				rm -f "$tmp"
			fi
		fi
		;;
	uninstall)
		git rev-parse --git-dir > /dev/null 2>&1 || exit 0

		# Public URLs back into the worktree BEFORE the filter goes. Drop the config
		# first and the clean filter no longer knows what to strip, so the next
		# `git add yarn.lock` stages the mirror host and the pre-commit gate blocks
		# the commit — with the one mechanism that could have fixed it removed.
		if [ -f yarn.lock ] && [ -n "$(configured_mirror)" ]; then
			tmp="$(mktemp)"
			if "$0" clean < yarn.lock > "$tmp"; then
				mv "$tmp" yarn.lock
			else
				rm -f "$tmp"
			fi
		fi

		git config --remove-section yarnlock-registry 2> /dev/null || true
		git config --remove-section filter.yarnlock-registry 2> /dev/null || true
		;;
	*)
		echo "usage: $0 clean|smudge|install|uninstall" >&2
		exit 1
		;;
esac
