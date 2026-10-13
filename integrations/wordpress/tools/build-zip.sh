#!/usr/bin/env bash
# Builds integrations/wordpress/mad3oom-support-<version>.zip from the plugin
# source. Regenerates the .pot and the Arabic .mo first, then zips with fixed
# timestamps and a sorted file list so the archive is reproducible.
# tests/wordpress-plugin.test.mjs checks the archive matches the source.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN="$HERE/mad3oom-support"
VERSION=$(sed -n 's/^ \* Version: *//p' "$PLUGIN/mad3oom-support.php" | tr -d '[:space:]')
OUT="$HERE/mad3oom-support-$VERSION.zip"

php "$HERE/tools/make-pot.php" "$PLUGIN" "$PLUGIN/languages/mad3oom-support.pot"
php "$HERE/tools/po2mo.php" "$PLUGIN/languages/mad3oom-support-ar.po" "$PLUGIN/languages/mad3oom-support-ar.mo"
for f in $(cd "$PLUGIN" && find . -name '*.php'); do php -l "$PLUGIN/$f" >/dev/null; done

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$PLUGIN" "$STAGE/mad3oom-support"
find "$STAGE" -exec touch -h -d '2026-10-12 00:00:00 UTC' {} +
rm -f "$OUT"
(cd "$STAGE" && find mad3oom-support -type f | LC_ALL=C sort | zip -X -q -@ "$OUT")
echo "$OUT ($(wc -c < "$OUT") bytes, sha256 $(sha256sum "$OUT" | cut -d' ' -f1))"
