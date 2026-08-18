#!/bin/bash

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✔${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✖${NC} $1"
}

# Variables to track state for rollback
ORIGINAL_VERSION=""
NEW_VERSION=""
CHANGES_COMMITTED=false
CHANGES_PUSHED=false
TAG_CREATED=false
TAG_PUSHED=false
RELEASE_DATE=""

# Non-interactive mode: `publish.sh <version> --yes` (or -y) skips every
# prompt — version prompt, publish confirmation — and auto-rolls-back on
# error. With no args the script stays fully interactive.
VERSION_ARG=""
ASSUME_YES=false
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=true ;;
        -*) log_error "Unknown option: $arg"; exit 1 ;;
        *) VERSION_ARG="$arg" ;;
    esac
done

# Function to rollback changes
rollback() {
    log_warning "Rolling back changes..."

    if [ -n "$ORIGINAL_VERSION" ] && [ -n "$NEW_VERSION" ]; then
        # Reset version in package.json
        if [ -f "package.json" ]; then
            sed -i.bak "s/\"version\": \"$NEW_VERSION\"/\"version\": \"$ORIGINAL_VERSION\"/" package.json
            rm -f package.json.bak
        fi

        # Un-stamp the CHANGELOG date. An aborted release must not leave a dated
        # heading for a version that never shipped — that is a fresh instance of
        # the defect release-time stamping exists to prevent. No-op if the git
        # reset below already restored the file.
        if [ -n "$RELEASE_DATE" ] && [ -f "CHANGELOG.md" ]; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s/^## $NEW_VERSION - $RELEASE_DATE$/## $NEW_VERSION - unreleased/" CHANGELOG.md
            else
                sed -i "s/^## $NEW_VERSION - $RELEASE_DATE$/## $NEW_VERSION - unreleased/" CHANGELOG.md
            fi
        fi

        # Reset git if changes were committed (restore original commit before amend)
        if [ "$CHANGES_COMMITTED" = true ]; then
            git reset --hard HEAD@{1} 2>/dev/null || true

            if [ "$CHANGES_PUSHED" = true ]; then
                log_warning "Force pushing to restore original commit..."
                git push --force-with-lease origin main 2>/dev/null || true
            fi
        fi

        # Delete local tag if created
        if [ "$TAG_CREATED" = true ]; then
            git tag -d "v$NEW_VERSION" 2>/dev/null || true
        fi

        # Delete remote tag if pushed
        if [ "$TAG_PUSHED" = true ]; then
            git push origin ":refs/tags/v$NEW_VERSION" 2>/dev/null || true
        fi

        log_success "Rollback completed"
    fi
}

# Error handler
handle_error() {
    log_error "Publishing failed: $1"

    if [ -n "$ORIGINAL_VERSION" ] && [ -n "$NEW_VERSION" ]; then
        if [ "$ASSUME_YES" = true ]; then
            log_warning "Non-interactive mode: rolling back automatically"
            rollback
        else
            read -p "Do you want to rollback changes? (y/N): " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                rollback
            fi
        fi
    fi

    exit 1
}

# Trap errors
trap 'handle_error "Unexpected error occurred"' ERR

echo -e "${BLUE}🚀 langsys-js-typescript Publishing Script${NC}\n"

# Check prerequisites
log_info "Checking prerequisites..."

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    handle_error "GitHub CLI (gh) is not installed. See _dev_/GITHUB_CLI_SETUP.md"
fi
log_success "GitHub CLI is installed"

# Check if gh CLI is authenticated
if ! gh auth status &> /dev/null; then
    if [ "$ASSUME_YES" = true ]; then
        handle_error "GitHub CLI is not authenticated (run 'gh auth login' first — can't prompt in non-interactive mode)"
    fi
    log_warning "GitHub CLI is not authenticated"
    echo "The GitHub CLI needs to be authenticated to create releases."
    echo "This is a one-time setup that will be saved for future use."
    echo
    read -p "Would you like to authenticate now? (Y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        log_info "Starting GitHub authentication..."
        if ! gh auth login; then
            handle_error "GitHub authentication failed"
        fi
        log_success "GitHub authentication completed"
    else
        handle_error "GitHub authentication is required to create releases"
    fi
else
    log_success "GitHub CLI is authenticated"
fi

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    handle_error "Not in a git repository"
fi

# Check if we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    handle_error "You must be on the main branch to publish. Current branch: $CURRENT_BRANCH"
fi

# Fetch FIRST. This position is load-bearing, not tidiness: both checks below
# are correct only against a fresh remote-tracking ref, and a stale one breaks
# them in opposite directions.
#
# The ahead-check in particular fails dangerously when stale. If HEAD was
# already pushed from another machine, a stale ref still reports ahead=1, the
# divergence guard legitimately passes (nobody else committed, nothing has
# diverged), and the script goes on to amend an ALREADY-PUBLISHED commit and
# force-push the rewrite -- orphaning that release's tag and its provenance
# attestation on a SHA that no longer exists, with no second party involved.
# Reading it after the fetch instead aborts with "No unpushed commits found",
# which is the correct outcome: this script amends HEAD to embed the version
# bump, so when HEAD is already published, amending it IS the rewrite.
# Reproduced in a sandbox 2026-08-18.
git fetch > /dev/null 2>&1

# Refuse to publish when origin/main carries commits we do not have.
#
# LOAD-BEARING. Do NOT delete this as redundant with the --force-with-lease
# push later in this script -- that reasoning is exactly what reintroduces the
# bug. The lease compares origin/main against our REMOTE-TRACKING ref, and the
# fetch above refreshes precisely that ref, so a commit someone else pushed is
# already "expected" by the time the lease is evaluated. The lease then
# authorises the destruction it exists to prevent: the push reports a forced
# update, exits 0, and warns about nothing. Reproduced in a sandbox 2026-08-18.
#
# This guard must stay ABOVE the ORIGINAL_VERSION assignment: handle_error only
# offers the rollback path once the version vars are set, so firing here aborts
# cleanly with nothing to undo.
BEHIND_COMMITS=$(git rev-list HEAD..origin/main --count)
if [ "$BEHIND_COMMITS" != "0" ]; then
    handle_error "origin/main has $BEHIND_COMMITS commit(s) you do not have. Publishing would force-push over them, destroying published history. Rebase first: git pull --rebase origin main"
fi

# Check for unpushed commits
UNPUSHED_COMMITS=$(git rev-list origin/main..HEAD --count)
if [ "$UNPUSHED_COMMITS" = "0" ]; then
    handle_error "No unpushed commits found. Commit your changes before publishing."
fi
log_success "Found $UNPUSHED_COMMITS unpushed commit(s)"

log_success "All prerequisites met"

# Get current version
ORIGINAL_VERSION=$(node -p "require('./package.json').version")
log_info "Current version: $ORIGINAL_VERSION"

# Calculate suggested version (increment patch version)
SUGGESTED_VERSION=$(echo "$ORIGINAL_VERSION" | awk -F. '{$NF = $NF + 1;} 1' | sed 's/ /./g')

# Version from CLI arg, or prompt for it
if [ -n "$VERSION_ARG" ]; then
    NEW_VERSION=$VERSION_ARG
    log_info "Using version from argument: $NEW_VERSION"
else
    read -p "Enter new version (suggested: $SUGGESTED_VERSION): " NEW_VERSION
    if [ -z "$NEW_VERSION" ]; then
        NEW_VERSION=$SUGGESTED_VERSION
    fi
fi

# Validate version format
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then
    handle_error "Invalid version format. Expected x.y.z or x.y.z-tag"
fi

# Check if version already exists as a tag
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
    handle_error "Version v$NEW_VERSION already exists as a tag"
fi

# Confirm before proceeding
if [ "$ASSUME_YES" = true ]; then
    log_info "Non-interactive mode: publishing version $NEW_VERSION"
else
    echo
    read -p "Ready to publish version $NEW_VERSION? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warning "Publishing cancelled"
        exit 0
    fi
fi

echo

# Update version in package.json
log_info "Updating version in package.json..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/\"version\": \"$ORIGINAL_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
else
    sed -i "s/\"version\": \"$ORIGINAL_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
fi
log_success "Updated package.json version to $NEW_VERSION"

# Run npm install to update package-lock.json
log_info "Running npm install to update package-lock.json..."
npm install

# Run build to ensure everything compiles
log_info "Running build to verify everything compiles..."
npm run build

# Amend the last commit with version bump
log_info "Amending last commit with version bump..."
# Stamp the release date into CHANGELOG.md at RELEASE time, not authoring time.
# Entries are written as `## X.Y.Z - unreleased`; the date is filled in here,
# seconds before publish, so the tarball itself carries a correct date rather
# than shipping the word "unreleased" to npm readers.
#
# Authoring-time dates are what produced six wrong entries across three repos
# (two off by a month): a heading written days before release records when it
# was TYPED, not when it shipped. Release time is within seconds of the npm
# publish record, so the two agree. Verify after publishing regardless:
#   npm view <pkg> time --json
RELEASE_DATE="$(date +%Y-%m-%d)"
if grep -q "^## $NEW_VERSION - unreleased$" CHANGELOG.md 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/^## $NEW_VERSION - unreleased$/## $NEW_VERSION - $RELEASE_DATE/" CHANGELOG.md
    else
        sed -i "s/^## $NEW_VERSION - unreleased$/## $NEW_VERSION - $RELEASE_DATE/" CHANGELOG.md
    fi
    log_success "Stamped CHANGELOG date for $NEW_VERSION as $RELEASE_DATE"
    git add CHANGELOG.md
elif ! grep -q "^## $NEW_VERSION - " CHANGELOG.md 2>/dev/null; then
    log_warning "No CHANGELOG section for $NEW_VERSION — add one before or after release"
fi

git add package.json package-lock.json

LAST_COMMIT_MESSAGE=$(git log -1 --pretty=%B)
AMENDED_MESSAGE="$LAST_COMMIT_MESSAGE

[Version bumped to $NEW_VERSION]"

echo "$AMENDED_MESSAGE" | git commit --amend -F -
CHANGES_COMMITTED=true

# Push to origin (force since we amended)
log_info "Pushing to origin..."
git push --force-with-lease origin main
CHANGES_PUSHED=true

# Create and push tag
log_info "Creating and pushing tag..."
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
TAG_CREATED=true
git push origin "v$NEW_VERSION"
TAG_PUSHED=true

# Create GitHub release
log_info "Creating GitHub release..."

COMMIT_MESSAGES=""
if git rev-parse "v$ORIGINAL_VERSION" >/dev/null 2>&1; then
    COMMITS=$(git log --oneline "v$ORIGINAL_VERSION"..HEAD --reverse)
else
    COMMITS=$(git log --oneline --reverse)
fi

if [ -n "$COMMITS" ]; then
    COMMIT_MESSAGES="

## Changes in this release

"
    while IFS= read -r commit; do
        if [ -n "$commit" ]; then
            COMMIT_HASH=$(echo "$commit" | cut -d' ' -f1)
            COMMIT_MSG=$(echo "$commit" | cut -d' ' -f2-)
            FULL_COMMIT_MSG=$(git log --format=%B -n 1 "$COMMIT_HASH")
            COMMIT_MESSAGES="$COMMIT_MESSAGES- [\`$COMMIT_HASH\`](https://github.com/langsys/langsys-js-typescript/commit/$COMMIT_HASH)
  $FULL_COMMIT_MSG

"
        fi
    done <<< "$COMMITS"
fi

RELEASE_NOTES="Release v$NEW_VERSION

## Installation

\`\`\`bash
npm install langsys-js-typescript@$NEW_VERSION
\`\`\`$COMMIT_MESSAGES

## Full Changelog

See the [commit history](https://github.com/langsys/langsys-js-typescript/compare/v$ORIGINAL_VERSION...v$NEW_VERSION) for the complete diff."

gh release create "v$NEW_VERSION" \
    --title "v$NEW_VERSION" \
    --notes "$RELEASE_NOTES"

echo
log_success "🎉 GitHub release v$NEW_VERSION created!"
log_info "The 'Publish to npm' GitHub Action will now build and publish via trusted publishing."
log_info "Watch the run: https://github.com/langsys/langsys-js-typescript/actions"
log_success "Release page: https://github.com/langsys/langsys-js-typescript/releases/tag/v$NEW_VERSION"
log_success "npm (once CI finishes): https://www.npmjs.com/package/langsys-js-typescript/v/$NEW_VERSION"
