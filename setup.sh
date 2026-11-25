#!/bin/sh
# open-slide-server setup: settings, Claude login, data directories, start, self-check.
# Safe to run again (keeps existing .env, token and data).
set -eu
cd "$(dirname "$0")"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" "default"
	printf '%s' "$2${3:+ [$3]}: "
	read -r _a || true
	eval "$1=\${_a:-\$3}"
}

command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (docker compose ...)"
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Run as a user in the 'docker' group (or with sudo)."

# ---- settings ---------------------------------------------------------------------------------
if [ ! -f .env ]; then
	say "Settings (.env)"
	ask url "Public URL (what you open in the browser)" "https://slides.example.com"
	ask port "Local port for your reverse proxy (gateway listens on 127.0.0.1)" "8080"
	echo "$url" | grep -Eq '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' || die "URL must look like https://slides.example.com"
	echo "$port" | grep -Eq '^[0-9]{2,5}$' || die "invalid port"
	umask 077
	sed -e "s#^PUBLIC_URL=.*#PUBLIC_URL=$url#" -e "s#^PORT=.*#PORT=$port#" .env.example >.env
	umask 022
	echo "Wrote .env (edit it any time, then: docker compose up -d)"
fi

# ---- images -----------------------------------------------------------------------------------
say "Getting the images"
if ! docker compose pull --quiet; then
	echo "Couldn't download prebuilt images; building them locally instead (a few minutes)."
	docker compose build
fi

# ---- data directories (owned by uid 1000, the user every container runs as) --------------------
say "Preparing ./data"
mkdir -p data
docker run --rm -v "$PWD/data:/data" --user 0 --network none --entrypoint sh \
	"$(docker compose config --images | grep open-slide-server-app | head -1)" -c '
	set -e
	cd /data
	mkdir -p projects/.none git keys state/requests state/view/results public/www public/builds \
		jobs/build jobs/deps control home
	for l in active build-src deps-src; do [ -e "$l" ] || [ -L "$l" ] || ln -s projects/.none "$l"; done
	touch control/generation
	chown -R 1000:1000 /data
	chown -h 1000:1000 active build-src deps-src
	chmod 700 keys state/requests claude claude-pki'

# ---- start ------------------------------------------------------------------------------------
say "Starting"
docker compose up -d
echo "Waiting for the first project to be set up (npm install, about a minute)..."
i=0
until docker compose exec -T worker test -e /data/projects/main/node_modules/@open-slide/core 2>/dev/null; do
	i=$((i + 1))
	[ $i -gt 180 ] && die "the first project wasn't ready after 6 minutes; see: docker compose logs worker deps"
	sleep 2
done
sleep 5
say "Self-check"
SKIP_CLAUDE=1 sh scripts/check.sh || true
. ./.env
say "Running on http://${BIND:-127.0.0.1}:${PORT:-8080}"
echo "Now put HTTPS + your login in front (everything except /share/), see docs/ingress.md,"
echo "then open $PUBLIC_URL and save your Claude token there (run 'claude setup-token' on any"
echo "computer with Claude Code). Re-run the self-check incl. Claude afterwards: sh scripts/check.sh"
