#!/usr/bin/env bash
# Run the full Qodana Ultimate scan set for this service, with QODANA_TOKEN
# auto-loaded from .env (the Qodana CLI reads process env, not the .env file).
# The token is exported into the process env and is never printed.
#
# Scans enabled (configured in qodana.yaml):
#   - code inspections + SAST / taint dataflow   (qodana.recommended profile)
#   - vulnerable-dependency check (SCA)           (Ultimate, automatic)
#   - third-party license audit                   (Ultimate Plus, raiseLicenseProblems)
#   - test coverage                               (vitest lcov -> --coverage-dir)
#
# Extra args pass through to `qodana scan`, e.g. ./qodana.sh --baseline qodana.sarif.json
# Env:
#   SKIP_TESTS=1   reuse the existing coverage/lcov.info instead of re-running vitest
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
	echo "qodana.sh: .env not found next to this script" >&2
	exit 1
fi

# Read QODANA_TOKEN only. Take everything after the first '=', strip one optional
# layer of surrounding single/double quotes. Never echo the value.
QODANA_TOKEN="$(grep -E '^[[:space:]]*QODANA_TOKEN[[:space:]]*=' .env | tail -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
if [[ -z "${QODANA_TOKEN:-}" ]]; then
	echo "qodana.sh: QODANA_TOKEN missing or empty in .env" >&2
	exit 1
fi
export QODANA_TOKEN

# Regenerate coverage so the coverage scan reflects the current code.
# vitest writes lcov to coverage/lcov.info (reporter configured in vitest.config.mts).
# `|| true`: a <100% threshold miss must not abort the scan here — Qodana enforces the
# 100% gate itself (qodana.yaml testCoverageThresholds) and reports the shortfall.
# vitest still writes coverage/lcov.info before it fails on the threshold.
#
# NOTE: test:cov runs the `integration` project, which boots the server against the REAL
# Redis cluster (REDIS_* from .env). If the cluster is unreachable, integration bails and
# lcov.info keeps the PREVIOUS run's numbers — Qodana would then scan stale coverage. Ensure
# the cluster is reachable before trusting the coverage verdict. See COVERAGE.md.
if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
	yarn test:cov || true
elif [[ ! -f coverage/lcov.info ]]; then
	echo "qodana.sh: SKIP_TESTS=1 but coverage/lcov.info is missing — run once without SKIP_TESTS first" >&2
	exit 1
fi

# A scan killed mid-flight (Ctrl-C, a truncated pipe, a crashed terminal) leaves its
# container behind, and the CLI derives the container name from the project path — so every
# later run dies with "container name ... is already in use" and never scans anything.
# Remove only *stopped* qodana containers: a running one belongs to a concurrent scan.
stale="$(docker ps -aq --filter 'name=^qodana-cli-' --filter 'status=exited' --filter 'status=created' --filter 'status=dead' 2>/dev/null || true)"
if [[ -n "$stale" ]]; then
	echo "qodana.sh: removing $(wc -w <<< "$stale") stale qodana container(s) from an interrupted run"
	docker rm -f $stale >/dev/null || true
fi

# Qodana's IntelliJ JS language service runs as `node --max_old_space_size=1024` inside the scan
# container and aborts (SIGABRT) when it hits that hardcoded 1 GB cap. Where the kernel writes the
# dump is decided by the *host's* /proc/sys/kernel/core_pattern: a bare relative pattern like "core"
# (plus core_uses_pid=1 -> "core.<pid>") puts it in the crashing process's cwd, which is the
# bind-mounted project root. On this workstation that reached 12 files and 15.2 GB in
# marketplace-common before anyone noticed, and `prettier --check` then died on them with "Invalid
# string length" — prettier reads a file before deciding it cannot format it.
#
# The host has since been given an absolute core_pattern, which is the real fix, but it is one
# machine-wide setting that no repo controls: a reboot without a persisted sysctl, another
# workstation, or CI brings the exposure straight back. `ulimit -c 0` here would not help either —
# the container inherits RLIMIT_CORE from the docker *daemon*, not from this client shell. So sweep
# after the scan, which is the part this repo does control.
#
# Only `core.<digits>` and a bare `core` that really is an ELF core dump are removed, so a future
# source file or directory named `core` survives untouched.
sweep_core_dumps() {
	local f found=0 total=0
	for f in core core.[0-9]*; do
		[[ -f "$f" ]] || continue
		[[ "$(LC_ALL=C od -An -tx1 -N4 "$f" 2>/dev/null | tr -d ' ')" == "7f454c46" ]] || continue
		total=$((total + $(wc -c < "$f")))
		rm -f "$f"
		found=$((found + 1))
	done
	if ((found > 0)); then
		echo "qodana.sh: removed $found core dump(s) ($((total / 1024 / 1024)) MB) left by a crashed process inside the scan container" >&2
	fi
}
trap sweep_core_dumps EXIT

# --run-promo true forces the promo (Ultimate) inspections on alongside the profile.
# Not `exec`: the EXIT trap above has to survive the scan, including a Ctrl-C or a crash.
qodana scan --run-promo true --coverage-dir coverage "$@"
