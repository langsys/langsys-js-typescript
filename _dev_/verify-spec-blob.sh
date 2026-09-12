#!/usr/bin/env bash
#
# Verify that CONFORMANCE.md's "Spec revision read" row names the blob that the
# commit it cites actually carries.
#
# WHY THIS EXISTS. Spec 8.0.1 requires the header revision to be re-derived on
# every write rather than carried forward, and that requirement exists because
# this file got it wrong: it once shipped a header citing a four-revision-stale
# blob beside its own specVersion row. Re-deriving is a manual step, a manual step
# that has already been skipped once will be skipped again, and the failure is
# invisible — a stale blob reference looks exactly like a fresh one.
#
# DELIBERATELY NOT A TEST, AND NOT IN CI. It reads a sibling checkout of the spec
# repo, which does not exist on a CI runner. A vitest case would therefore have to
# skip there, and a check that silently skips where it is automated is the exact
# shape that let the #private dist scan sit green for rounds while asserting
# nothing. Better an honest manual command than an automated no-op.
#
# Run it BEFORE writing the header, and paste what it prints.
#
#   ./_dev_/verify-spec-blob.sh                    # uses ~/Documents/dev/langsys2
#   ./_dev_/verify-spec-blob.sh /path/to/langsys2
#
# Exit codes: 0 agrees · 1 MISMATCH · 2 cannot check (missing repo, unparsable
# header). Never 0 unless it actually verified something.

set -euo pipefail

SPEC_REPO="${1:-$HOME/Documents/dev/langsys2}"
SPEC_PATH="docs/sdk-spec.mdx"
CONFORMANCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/CONFORMANCE.md"

die() { printf '%s\n' "$1" >&2; exit "${2:-2}"; }

[ -f "$CONFORMANCE" ] || die "cannot find CONFORMANCE.md next to _dev_/"
[ -d "$SPEC_REPO/.git" ] || die "no git repo at $SPEC_REPO
Pass the spec checkout as the first argument. This script cannot verify anything
without it, and exits 2 rather than pretending to pass."

header="$(grep -m1 '^| \*\*Spec revision read\*\*' "$CONFORMANCE" || true)"
[ -n "$header" ] || die "no 'Spec revision read' row found in CONFORMANCE.md"

# `langsys <commit>` and the 40-hex blob, both from the row's own prose.
claimed_commit="$(printf '%s' "$header" | sed -n 's/.*langsys \`\([0-9a-f]\{7,40\}\)\`.*/\1/p')"
claimed_blob="$(printf '%s' "$header" | grep -o '[0-9a-f]\{40\}' | head -1)"

[ -n "$claimed_commit" ] || die "could not read the cited commit out of the header row"
[ -n "$claimed_blob" ] || die "could not read the cited 40-hex blob out of the header row"

git -C "$SPEC_REPO" cat-file -e "${claimed_commit}^{commit}" 2>/dev/null \
    || die "commit $claimed_commit is not in $SPEC_REPO (fetch, or the header is wrong)"

actual_blob="$(git -C "$SPEC_REPO" ls-tree "$claimed_commit" "$SPEC_PATH" | awk '{print $3}')"
[ -n "$actual_blob" ] || die "$SPEC_PATH is not present at $claimed_commit"

spec_version="$(git -C "$SPEC_REPO" cat-file -p "$actual_blob" \
    | sed -n 's/^specVersion: *\(.*\)$/\1/p' | head -1)"

printf 'CONFORMANCE cites : %s @ %s\n' "$claimed_blob" "$claimed_commit"
printf 'ls-tree reports   : %s\n' "$actual_blob"
printf 'blob specVersion  : %s\n' "${spec_version:-<none found>}"

# ADVISORY, never a failure: the cited commit agreeing is the contract, but a spec
# that has moved on since is the thing worth surfacing. A later revision can change
# the TEXT behind a rule while this check stays happily green, because it compares
# against the commit the header names and nothing else. That is by design — being
# behind is legitimate until somebody re-audits — but silently behind is how a
# payload goes unnoticed. The Reviewer asked for this after 63df13c7..5c747e7d
# removed two ids this repo had quoted as "the spec says".
head_blob="$(git -C "$SPEC_REPO" ls-tree HEAD "$SPEC_PATH" 2>/dev/null | awk '{print $3}' || true)"
if [ -n "$head_blob" ] && [ "$head_blob" != "$actual_blob" ]; then
    printf '\nADVISORY: the spec has moved since %s.\n' "$claimed_commit"
    printf '  spec HEAD blob : %s\n' "$head_blob"
    printf '  cited blob     : %s\n' "$actual_blob"
    printf '  diff           : git -C %s diff %s..HEAD -- %s\n' "$SPEC_REPO" "$claimed_commit" "$SPEC_PATH"
    printf 'Not a failure. But re-deriving is a RE-AUDIT, not a hash swap: read the diff for\n'
    printf 'sentences this repo quotes back, and check every claim of the form "the spec says".\n'
fi

if [ "$claimed_blob" = "$actual_blob" ]; then
    printf '\nAGREES. Header is re-derived against %s.\n' "$claimed_commit"
    exit 0
fi

printf '\nMISMATCH. The header names a blob that %s does not carry.\n' "$claimed_commit"
printf 'Update the row to %s, and re-audit the rules against it — a moved blob\n' "$actual_blob"
printf 'means the text behind the rules changed, not just the hash.\n'
exit 1
