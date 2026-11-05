#!/bin/sh
# Builds MyNotes in the Podman container and installs it as an Arch package. Run it again to update.
set -eu
cd "$(dirname "$0")"

# The same version a release of this commit gets (see .github/workflows/build.yml), so pacman sees an update as one
base=$(git log -1 --format=%H -G'^\s*"version":' -- package.json)
major_minor=$(sed -n 's/^  "version": "\([0-9]*\.[0-9]*\)\..*/\1/p' package.json)
version=$major_minor.$(git rev-list --count "$base..HEAD")

# Cached layers make this quick. The volumes keep node_modules and Electron's download for the next run.
podman build -q -t mynotes-dev .devcontainer
podman run --rm -v "$PWD:/workspace" -v mynotes-modules:/workspace/node_modules -v mynotes-cache:/root/.cache \
    -w /workspace -e VERSION="$version" mynotes-dev bash -c \
    'npm ci && node build.mjs && npx electron-builder --linux pacman "-c.extraMetadata.version=$VERSION"'

sudo pacman -U "release/mynotes-$version.pacman"
echo "MyNotes $version is installed. If it is running, restart it to get the new version."
