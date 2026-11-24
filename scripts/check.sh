#!/bin/sh
# Self-check of the security properties. Run any time: sh scripts/check.sh
# Uses only the running containers (no extra tools on the host besides docker and curl).
set -u
cd "$(dirname "$0")/.."
. ./.env
BIND=${BIND:-127.0.0.1} PORT=${PORT:-8080}
HOST=$(echo "$PUBLIC_URL" | sed -E 's#^https?://##; s#:[0-9]+$##')
[ "$BIND" = 0.0.0.0 ] && BIND=127.0.0.1
pass=0 fail=0
ok() { pass=$((pass + 1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
expect() { # expect <description> <wanted> <got>
	if [ "$3" = "$2" ]; then ok "$1 ($3)"; else bad "$1: wanted $2, got $3"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOST" "$@"; }
G="http://$BIND:$PORT"
ed() { docker compose exec -T editor node -e "$1" 2>&1; }

echo "Gateway (local; login is up to your reverse proxy)"
expect "unknown share link" 404 "$(code "$G/share/AAAAAAAAAAAAAAAAAAAAAA/")"
expect "share path traversal" 404 "$(code --path-as-is "$G/share/AAAAAAAAAAAAAAAAAAAAAA/../../editor/")"
r=$(code --path-as-is "$G/share/AAAAAAAAAAAAAAAAAAAAAA/%2e%2e/%2e%2e/editor/")
case "$r" in 401 | 404) ok "encoded traversal ($r)" ;; *) bad "encoded traversal: got $r" ;; esac
expect "cross-site POST to the API" 403 "$(code -X POST -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: cors' "$G/api/request")"
expect "unknown host name" 421 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$G/")"

echo "Editor sandbox (runs code from your repos)"
r=$(ed 'fetch("https://example.com").then(r=>console.log("REACHED "+r.status)).catch(e=>console.log("blocked"))')
expect "no internet" blocked "$r"
r=$(ed 'const s=require("net").connect({host:"1.1.1.1",port:443,timeout:3000});s.on("connect",()=>{console.log("REACHED");process.exit()});s.on("timeout",()=>{console.log("blocked");process.exit()});s.on("error",()=>console.log("blocked"))')
expect "no direct IP access" blocked "$r"
r=$(ed 'fetch("http://gateway:8080/api/status").then(r=>console.log("REACHED "+r.status)).catch(e=>console.log("blocked"))')
expect "editor can't reach the gateway / start page" blocked "$r"
r=$(ed 'fetch("http://admin:8080/api/status").then(r=>console.log("REACHED "+r.status)).catch(e=>console.log("blocked"))')
expect "editor can't reach the admin" blocked "$r"
r=$(ed 'const gw=require("fs").readFileSync("/proc/net/route","utf8").split("\n").slice(1).map(l=>l.split("\t")).find(c=>c[1]==="00000000");console.log(gw?"has-default-route":"no-route")')
expect "no route to the host" no-route "$r"
r=$(ed 'console.log(process.env.CLAUDE_CODE_OAUTH_TOKEN)')
expect "editor has only a placeholder token" replaced-by-claude-proxy "$r"
r=$(docker compose exec -T editor sh -c 'grep -rlE "sk-ant-(oat|api)[0-9]{2}-[A-Za-z0-9_-]{30,}" /home/node /workspace/.claude 2>/dev/null | head -1; ls /home/node/.claude/.credentials.json 2>/dev/null')
expect "no Claude credentials in the editor's files" "" "$r"
r=$(ed 'fetch("http://claude-proxy:8080/v1/files").then(r=>console.log(r.status)).catch(e=>console.log("err"))')
expect "claude-proxy only forwards Claude API calls" 403 "$r"

echo "Containers"
socks=$(docker compose ps -q | xargs docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep -c 'docker.sock')
expect "no container has the Docker socket" 0 "$socks"
root=$(docker compose ps -q | xargs docker inspect --format '{{.Name}} user={{.Config.User}}' | grep -Evc 'user=(1000:1000|65534:65534)$')
expect "no container runs as root" 0 "$root"

echo "Claude (one tiny request through the proxy)"
if [ "${SKIP_CLAUDE:-}" = 1 ]; then
	echo "  skipped (SKIP_CLAUDE=1)"
else
	r=$(docker compose exec -T -w /tmp editor sh -c 'timeout 90 claude -p "Reply with exactly: OK" 2>&1 | tail -n1')
	case "$r" in *OK*) ok "the agent can reach Claude" ;; *) bad "Claude request failed: $r" ;; esac
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
