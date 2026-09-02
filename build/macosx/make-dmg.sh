#!/bin/bash
# Build a release DMG around an already-signed .app bundle.
#
# `mach package` cannot be used for this. It builds its image with
# `hdiutil makehybrid`, which synthesises HFS metadata for every entry it
# copies -- including a com.apple.FinderInfo xattr on files inside the
# bundle. codesign counts that as "resource fork, Finder information, or
# similar detritus not allowed" and the signature that verified before
# packaging fails inside the image. Every file gets one, so the app arrives
# broken however carefully it was signed beforehand.
#
# Worse, it fails in the way that cannot be waived: right-click Open gets past
# an unnotarised *policy* rejection, but nothing gets past a signature that
# does not verify.
#
# So the image is assembled by hand instead: a read-write image, the bundle
# copied in with ditto -- which reproduces a signed bundle exactly, xattrs and
# all, and adds nothing -- then converted to the compressed read-only format.
# The verification at the end is the point of the script; it checks the copy
# inside the image rather than the one on disk that was signed.

set -euo pipefail

APP="${1:?usage: ${0##*/} /path/to/App.app /path/to/out.dmg}"
OUT="${2:?usage: ${0##*/} /path/to/App.app /path/to/out.dmg}"
VOLUME_NAME="${VOLUME_NAME:-Thunderbird AI}"
BRANDING="${BRANDING:-$(dirname "$0")/../../mail/branding/nightly}"

[[ -d "$APP" ]] || { echo "not a bundle: $APP" >&2; exit 1; }

echo "verifying the bundle before it is copied..."
codesign --verify --deep --strict "$APP"

stage=$(mktemp -d)
mount=""
cleanup() {
    [[ -n "$mount" ]] && hdiutil detach "$mount" -quiet 2>/dev/null || true
    rm -rf "$stage"
}
trap cleanup EXIT

# The window layout, the backdrop it refers to, and the volume's own icon.
# The symlink is named with a space so it needs no localising, which is what
# mozpack/dmg.py does too.
mkdir -p "$stage/.background"
cp "$BRANDING/background.png" "$stage/.background/background.png"
cp "$BRANDING/dsstore" "$stage/.DS_Store"
cp "$BRANDING/disk.icns" "$stage/.VolumeIcon.icns"
ln -s /Applications "$stage/ "

# ditto, not cp or rsync: it copies a signed bundle byte for byte, keeping the
# xattrs that belong to it and inventing none.
ditto "$APP" "$stage/$(basename "$APP")"

# Room for the filesystem's own overhead on top of the content.
size=$(( $(du -sm "$stage" | cut -f1) + 120 ))

rw="$stage.dmg"
hdiutil create -quiet -srcfolder "$stage" -volname "$VOLUME_NAME" \
    -fs HFS+ -format UDRW -size "${size}m" "$rw"

# Mounted only to set the volume's custom-icon bit, which lives in the
# FinderInfo of the volume root -- outside the bundle, so nothing signed.
mount=$(hdiutil attach -nobrowse -readwrite "$rw" | tail -1 | awk -F'\t' '{print $NF}')
SetFile -a C "$mount" 2>/dev/null || true

echo "verifying the copy inside the image..."
codesign --verify --deep --strict "$mount/$(basename "$APP")"

hdiutil detach "$mount" -quiet
mount=""

rm -f "$OUT"
hdiutil convert -quiet -format UDBZ -imagekey bzip2-level=9 "$rw" -o "$OUT"

echo "built and verified: $OUT"
