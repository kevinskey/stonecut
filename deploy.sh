#!/usr/bin/env bash
# Run on the production droplet. STONECUT_REF may be a full commit SHA or main.
# Builds a locked, tested release; future symlink switches are atomic.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run this deployment with sudo on the droplet.'; exit 1; }
REF="${STONECUT_REF:-main}"
HOST=rhinestones.tshirtbrothers.com
BASE=/var/www/stonecut
DOCROOT="$BASE/html"
nginx -T 2>/dev/null | python3 -c '
import re,sys
text=sys.stdin.read()
for m in re.finditer(r"\bserver\s*\{",text):
 depth=1;i=m.end();start=i
 while i<len(text) and depth:
  depth+=(text[i]=="{")-(text[i]=="}");i+=1
 block=text[start:i-1]
 names=re.findall(r"\bserver_name\s+([^;]+);",block)
 roots=re.findall(r"\broot\s+([^;]+);",block)
 if any("rhinestones.tshirtbrothers.com" in n.split() for n in names) and "/var/www/stonecut/html" in [r.strip() for r in roots]:sys.exit(0)
sys.exit("Refusing deployment: StoneCut vhost/document root not verified")'
[ -d "$DOCROOT" ] || { echo 'Document root is missing'; exit 1; }
OLD=$(readlink -f "$DOCROOT")
case "$OLD" in "$DOCROOT"|"$BASE"/releases/*) ;; *) echo 'Unexpected document-root target'; exit 1;; esac
WORK=$(mktemp -d /var/tmp/stonecut-build.XXXXXX)
SWAPPED=0
LEGACY_BACKUP=''
cleanup() {
 result=$?
 if [ "$result" -ne 0 ] && [ "$SWAPPED" = 1 ]; then
  ln -s "$OLD" "$DOCROOT.rollback-$$"
  mv -Tf "$DOCROOT.rollback-$$" "$DOCROOT"
  echo 'Restored previous release after failed verification'
 fi
 rm -rf "$WORK"
 exit "$result"
}
trap cleanup EXIT
git clone --quiet https://github.com/kevinskey/stonecut.git "$WORK/source"
cd "$WORK/source"
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then git checkout --quiet --detach "$REF"; else
 [ "$REF" = main ] || { echo 'Use main or a full commit SHA'; exit 1; }
 git checkout --quiet --detach origin/main
fi
SHA=$(git rev-parse HEAD)
echo "Building StoneCut $SHA"
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
RELEASE="$BASE/releases/$SHA"
[ ! -e "$RELEASE" ] || { echo 'Release directory already exists; refusing to overwrite it'; exit 1; }
mkdir -p "$BASE/releases"
cp -a dist "$RELEASE"
printf '{"commit":"%s"}\n' "$SHA" > "$RELEASE/build-info.json"
# Cached tabs may still request the preceding build's immutable assets.
if [ -d "$OLD/assets" ]; then cp -an "$OLD/assets/." "$RELEASE/assets/"; fi
ln -s "$RELEASE" "$DOCROOT.next-$$"
if [ ! -L "$DOCROOT" ]; then
 LEGACY_BACKUP="$BASE/html.before-releases-$(date -u +%Y%m%dT%H%M%SZ)"
 mv "$DOCROOT" "$LEGACY_BACKUP"
 OLD="$LEGACY_BACKUP"
 if ! mv -T "$DOCROOT.next-$$" "$DOCROOT"; then mv "$OLD" "$DOCROOT"; exit 1; fi
else
 mv -Tf "$DOCROOT.next-$$" "$DOCROOT"
fi
SWAPPED=1
CURL=(curl --fail --silent --show-error --retry 2 --max-time 30 --resolve "$HOST:443:127.0.0.1")
"${CURL[@]}" "https://$HOST/build-info.json" | python3 -c 'import json,sys;assert json.load(sys.stdin)["commit"]==sys.argv[1]' "$SHA"
"${CURL[@]}" "https://$HOST/" > "$WORK/live.html"
cmp dist/index.html "$WORK/live.html"
python3 - <<'PY' > "$WORK/assets.txt"
import re,urllib.parse
text=open('dist/index.html').read()
for asset in re.findall(r'(?:src|href)="([^\"]+)"',text):
 if asset.endswith(('.js','.css')):print(urllib.parse.urljoin('https://rhinestones.tshirtbrothers.com/',asset))
PY
while IFS= read -r url; do
 asset="${url#https://$HOST/}"
 "${CURL[@]}" "$url" > "$WORK/asset"
 cmp "dist/$asset" "$WORK/asset"
done < "$WORK/assets.txt"
printf '%s\n' "$OLD" > "$BASE/previous-release"
echo "STONECUT_DEPLOYED=$SHA"
echo "PREVIOUS_BUILD=$OLD"
