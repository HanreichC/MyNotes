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

# Keys on a graphics tablet (Settings › Tablet): MyNotes reads them itself from /dev/input. A udev rule makes them readable
# for the logged-in user (uaccess), only the key devices of tablets, never keyboards; MyCAD's rule does the same. Once, with
# sudo, only if a tablet is connected and neither rule is there yet.
rule=/etc/udev/rules.d/70-mynotes-tablet.rules
if [ ! -f "$rule" ] && [ ! -f /etc/udev/rules.d/70-mycad-tablet.rules ] && [ -t 0 ] && command -v udevadm >/dev/null \
    && udevadm info --export-db 2>/dev/null | grep -q '^E: ID_INPUT_TABLET_PAD=1'; then
    echo "==> Graphics tablet found: so MyNotes may read its keys, sudo creates $rule once"
    printf '%s\n' 'ACTION!="remove", SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TABLET_PAD}=="1", TAG+="uaccess"' \
        | sudo tee "$rule" >/dev/null \
        && sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=input \
        || echo "    Skipped. Without the rule MyNotes cannot read the keys on the tablet (the pen works all the same)."
fi
echo "MyNotes $version is installed. If it is running, restart it to get the new version."
