#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Function to check if the repository is clean
check_clean_repo() {
    echo "Checking if the repository is clean..."
    if [[ -n $(hg status) ]]; then
        echo "Error: The repository has uncommitted changes. Please commit or discard them before running this script."
        exit 1
    fi
}

# Function to resolve all conflicts by preferring 'local' changes
resolve_conflicts() {
    echo "Resolving all conflicts by preferring 'local' changes..."
    hg resolve --all --tool internal:local
}

# Function to verify no unresolved conflicts remain
verify_no_conflicts() {
    if hg resolve --list | grep -q "unresolved"; then
        echo "Error: There are unresolved conflicts after automatic resolution."
        exit 1
    fi
}

# Ensure the script is run in the 'local' branch
current_branch=$(hg branch)
if [ "$current_branch" != "local" ]; then
    echo "Error: This script must be run from the 'local' branch."
    exit 1
fi

# Check if the repository is clean
check_clean_repo

# Push any pending changes from 'local' to the remote 'local' branch
echo "Pushing local changes to the remote 'local' branch..."
hg push --branch local

# Update to the 'default' branch with a clean update
echo "Switching to the 'default' branch..."
hg update default --clean

# Pull the latest changes from the remote 'default' branch
echo "Pulling the latest changes from the remote 'default' branch..."
hg pull --update

# Merge changes from 'local' into 'default' with automatic conflict resolution
echo "Merging changes from 'local' into 'default' with automatic resolution..."
hg merge local --tool internal:other

# Resolve any remaining conflicts by preferring 'local' changes
resolve_conflicts

# Verify that all conflicts have been resolved
verify_no_conflicts

# Automatically add and remove files to ensure all changes are tracked
echo "Adding and removing files to reflect all changes from 'local'..."
hg addremove --similarity 100

# Double-check that there are no outstanding changes to commit
if [[ -n $(hg status --modified --added --removed --deleted) ]]; then
    echo "Committing all changes to 'default' branch..."
    hg commit -m "Merged changes from 'local' into 'default' (auto-resolved to prefer 'local')"
else
    echo "No changes to commit after merging. 'default' branch is already up-to-date with 'local'."
fi

# Push changes to the remote 'default' branch
echo "Pushing changes to the remote 'default' branch..."
hg push --branch default

# Switch back to the 'local' branch with a clean update
echo "Switching back to the 'local' branch..."
hg update local --clean

echo "Operation completed successfully! The 'default' branch now matches the 'local' branch."
