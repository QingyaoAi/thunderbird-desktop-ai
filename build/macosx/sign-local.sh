#!/bin/bash
# Ad-hoc sign a locally built .app bundle so Gatekeeper will launch it.
#
# Signing only happens in CI, so a local build leaves the bundle with the
# linker's per-binary ad-hoc signatures but no _CodeSignature seal. Gatekeeper
# reports that as "code has no resources but signature indicates they must be
# present" and tells the user the application is damaged.
#
# Sign the output of `mach package` (dist/<app>/*.app), not the `repackage`
# bundle at dist/*.app: the latter is rsynced from dist/bin with -a, so it
# keeps thousands of absolute symlinks into the objdir and cannot be signed
# or relocated. The cleanup pass below only exists so that bundle can still be
# signed for quick local iteration; on a packaged bundle it does nothing.
#
# Hardened runtime is deliberately not enabled. It requires the entitlements
# CI applies, and without them the JS JIT is refused memory and startup fails.

set -euo pipefail

APP="${1:?usage: ${0##*/} /path/to/App.app}"
[[ -d "$APP" ]] || { echo "not a bundle: $APP" >&2; exit 1; }

removed=0
prune() {
    local desc="$1"; shift
    local found
    found=$(("$@" -print | tee /dev/stderr | wc -l) 2>/dev/null) || return 0
    if ((found > 0)); then
        "$@" -delete
        removed=$((removed + found))
        echo "pruned $found $desc" >&2
    fi
}

# mail/app/Makefile.in rsyncs macbuild/Contents into the bundle excluding only
# *.in, so the template's own moz.build is copied in. codesign treats it as an
# unsignable nested component and refuses the whole bundle.
prune "stray moz.build" find "$APP/Contents" -maxdepth 1 -name moz.build

# Build stamps staged into bundle executable directories.
prune "build stamp" find "$APP" -name .mkdir.done

# Dangling symlinks are left in the objdir when a packaged file is dropped from
# a jar.mn; codesign fails on them with a bare ENOENT.
prune "dangling symlink" find "$APP" -type l ! -exec test -e {} \;

list_code() {
    find "$APP" -mindepth 1 \
        \( -name '*.app' -o -name '*.framework' -o -name '*.mdimporter' \
           -o -name '*.dylib' \) -print
    find "$APP" -mindepth 1 -type f -perm -u+x ! -name '*.dylib' -print0 |
        while IFS= read -r -d '' f; do
            [[ "$(file -b "$f")" == Mach-O* ]] && printf '%s\n' "$f"
        done
}

# Deepest paths first, so every nested item is sealed before its container.
failed=0
while IFS= read -r item; do
    codesign --force --sign - --timestamp=none "$item" >/dev/null 2>&1 || {
        echo "warn: could not sign ${item#"$APP"/}" >&2
        failed=$((failed + 1))
    }
done < <(list_code | awk -F/ '{ print NF "\t" $0 }' | sort -rn -k1,1 | cut -f2-)

codesign --force --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"
echo "signed and verified: $APP (${removed} artifacts pruned, ${failed} nested failures)"
