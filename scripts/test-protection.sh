#!/bin/sh
# Checks from the outside that your login protects open-slide-server.
# Usage: sh scripts/test-protection.sh https://slides.example.com
# Run it without any login cookies (this script sends none). Best also from another network.
set -u
URL=${1:?usage: sh scripts/test-protection.sh https://your.host}
URL=${URL%/}
fail=0
check() { # check <path> <expect: protected|404>
	code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$URL$1")
	case "$2:$code" in
	protected:000) printf '  \033[32mok\033[0m    %-44s not reachable (fine for Tailscale-only)\n' "$1" ;;
	protected:200 | protected:204 | protected:404 | protected:403)
		# 403/404 without a login page could still be the app itself; 200 definitely is.
		[ "$code" = 200 ] && { printf '  \033[31mOPEN\033[0m  %-44s %s: reachable WITHOUT login!\n' "$1" "$code"; fail=1; } ||
			printf '  \033[33m?\033[0m     %-44s %s: check in a private browser window that a login appears\n' "$1" "$code" ;;
	protected:*) printf '  \033[32mok\033[0m    %-44s %s (login required)\n' "$1" "$code" ;;
	404:404) printf '  \033[32mok\033[0m    %-44s 404 (share links reach the server)\n' "$1" ;;
	404:*) printf '  \033[33m!\033[0m     %-44s %s: share links need /share/ without login (expected 404 here)\n' "$1" "$code" ;;
	esac
}
echo "Testing $URL (no login):"
check / protected
check /editor/ protected
check /__agent/status protected
check /api/status protected
check /slides/ protected
check /share/AAAAAAAAAAAAAAAAAAAAAA/ 404
if [ "$fail" = 1 ]; then
	printf '\n\033[31mYour server is OPEN.\033[0m Stop it now (docker compose stop) and fix your login setup.\n'
	exit 1
fi
printf '\nLooks protected. Also open %s in a private browser window: you must see a login first.\n' "$URL/editor/"
