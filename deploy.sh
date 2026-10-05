#!/usr/bin/env bash
# Deploy StoneCut on the TSB droplet. Run as root (re-execs with sudo):
#   curl -fsSL https://raw.githubusercontent.com/kevinskey/stonecut/main/deploy.sh | bash
# Clones/updates this repo, builds it, finds the nginx root that serves
# rhinestones.tshirtbrothers.com, and swaps the build in. The previous build
# is kept next to it as <root>.prev so a bad deploy is one `mv` to undo.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exec sudo -E bash -s < <(cat "$0" 2>/dev/null || curl -fsSL https://raw.githubusercontent.com/kevinskey/stonecut/main/deploy.sh); fi

SRC=/var/www/stonecut-src
REF="${STONECUT_REF:-main}"
HOST=rhinestones.tshirtbrothers.com

if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q origin
else
  git clone -q https://github.com/kevinskey/stonecut.git "$SRC"
fi
git -C "$SRC" reset -q --hard "origin/$REF"
cd "$SRC"
echo "==> building stonecut $(git rev-parse --short HEAD) ($REF)"
npm install --no-audit --no-fund
if ! npm run build; then
  # npm bug #4828: a macOS lockfile can leave Linux native binaries out of
  # node_modules. Clean reinstall is the documented recovery.
  echo "==> build failed; clean reinstall and retry"
  rm -rf node_modules package-lock.json
  npm install --no-audit --no-fund
  npm run build
fi
[ -f dist/index.html ] || { echo "!! no dist/index.html after build"; exit 1; }

# nginx config files hold several server blocks; parse by block so the main
# tshirtbrothers root is never mistaken for the StoneCut one. `nginx -T`
# dumps the whole effective config wherever the vhost file actually lives.
find_root() {
  awk -v host="$HOST" '
    /server[[:space:]]*\{/ && depth == 0 { inblk = 1; blk = "" }
    inblk {
      blk = blk "\n" $0
      line = $0
      o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line)
      depth += o - c
      if (depth == 0) {
        if (index(blk, host) && match(blk, /[\n \t]root[ \t]+[^;]+;/)) {
          r = substr(blk, RSTART, RLENGTH)
          sub(/^[\n \t]*root[ \t]+/, "", r); sub(/;$/, "", r)
          print r; exit
        }
        inblk = 0
      }
    }'
}
DOCROOT="$(nginx -T 2>/dev/null | find_root || true)"
if [ -z "$DOCROOT" ]; then
  for f in $(grep -rl "$HOST" /etc/nginx 2>/dev/null || true); do
    DOCROOT="$(find_root < "$f")"
    [ -n "$DOCROOT" ] && break
  done
fi
if [ -z "$DOCROOT" ]; then
  # fallback: a deployed StoneCut index.html, anywhere nginx is likely to
  # serve from, that is not our own clone
  CANDIDATES="$(grep -rli --include=index.html '<title>stonecut</title>' /var/www /srv /home /opt /usr/share/nginx 2>/dev/null | grep -v "^$SRC/" || true)"
  [ -n "$CANDIDATES" ] && echo "==> index.html candidates:" && echo "$CANDIDATES"
  DOCROOT="$(echo "$CANDIDATES" | head -1 | xargs -r dirname || true)"
fi
if [ -z "$DOCROOT" ]; then
  echo "!! could not find the nginx root for $HOST. Diagnostics:"
  echo "--- nginx -T mentions of the host:"; nginx -T 2>/dev/null | grep -n -i "rhinestones\|server_name\|root " | head -40
  echo "--- /etc/nginx layout:"; ls -la /etc/nginx /etc/nginx/sites-enabled /etc/nginx/conf.d 2>&1 | head -40
  echo "--- /var/www:"; ls -la /var/www 2>&1
  exit 1
fi
case "$DOCROOT" in
  ""|/|/var/www|/var/www/tshirtbrothers|/var/www/tshirtbrothers/*|"$SRC"|"$SRC"/*)
    echo "!! refusing to deploy: nginx root for $HOST resolved to '$DOCROOT'"; exit 1 ;;
esac
[ -d "$DOCROOT" ] || { echo "!! nginx root '$DOCROOT' is not a directory"; exit 1; }

echo "==> deploying to $DOCROOT (previous build kept at $DOCROOT.prev)"
STAGE="$DOCROOT.next"; PREV="$DOCROOT.prev"
rm -rf "$STAGE"; cp -a dist "$STAGE"
rm -rf "$PREV"; mv "$DOCROOT" "$PREV"; mv "$STAGE" "$DOCROOT"
echo "==> DEPLOYED. live bundle: $(grep -o 'index-[A-Za-z0-9_-]*\.js' "$DOCROOT/index.html" | head -1)"
