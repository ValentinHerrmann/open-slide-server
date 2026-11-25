#!/bin/sh
# Generates a ready-to-run protection setup (HTTPS + login in front of open-slide-server) into ./protect/.
# It changes nothing outside this folder: you review the files, start them, then run
#   sh scripts/test-protection.sh https://your.host
# Setups (details: docs/ingress.md):
#   1 Cloudflare Tunnel + Access      no open ports, login by email code/Google/GitHub
#   2 Caddy + Cloudflare (proxied)    your own Caddy with HTTPS, Cloudflare Access + origin checks
#   3 Caddy + basic auth              server with a public IP, one strong password
#   4 Tailscale only                  only your own devices
#   5 Caddy + SSO proxy               Authelia / authentik / oauth2-proxy you already run
set -eu
cd "$(dirname "$0")/.."
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { printf '%s' "$2${3:+ [$3]}: "; read -r _a || true; eval "$1=\${_a:-\$3}"; }
[ -f .env ] || die "run ./setup.sh first (no .env yet)"
. ./.env
PORT=${PORT:-8080}
HOST=$(echo "$PUBLIC_URL" | sed -E 's#^https?://##; s#[:/].*$##')
CADDY=caddy:2.11.4

cat <<EOF
Protection setups for $PUBLIC_URL (open-slide-server listens on 127.0.0.1:$PORT):
  1) Cloudflare Tunnel + Access     (recommended: no open ports, free)
  2) Caddy + Cloudflare (proxied)   (own Caddy on ports 80/443 behind Cloudflare, Access + origin checks)
  3) Caddy + basic auth             (public IP, one strong password)
  4) Tailscale only                 (only your own devices)
  5) Caddy + SSO proxy              (Authelia / authentik / oauth2-proxy)
EOF
ask choice "Choose" "1"
mkdir -p protect
chmod 700 protect

# Caddy site block shared by setups 3 and 5: /share/ public, everything else behind $AUTH.
caddy_site() { # caddy_site <auth block>
	cat <<EOF
$HOST {
	# Share links are public; everything else needs your login.
	@share path /share/*
	handle @share {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle {
$1
		reverse_proxy 127.0.0.1:$PORT
	}
}
EOF
}

caddy_compose() { # caddy_compose <image or build>
	cat <<EOF
# Caddy in front of open-slide-server. Start: docker compose -f protect/compose.yaml up -d
# Host networking: Caddy listens on 80/443 and reaches open-slide-server on 127.0.0.1:$PORT.
name: open-slide-protect
services:
  caddy:
$1
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
EOF
}

case "$choice" in
1) # ------------------------------------------------------------------ Cloudflare Tunnel + Access
	cat >protect/compose.yaml <<'EOF'
# Cloudflare Tunnel to open-slide-server. Start: docker compose -f protect/compose.yaml up -d
name: open-slide-protect
services:
  cloudflared:
    image: cloudflare/cloudflared:2026.11.0
    restart: unless-stopped
    network_mode: host # reaches 127.0.0.1:PORT; makes only outgoing connections
    command: ["tunnel", "--no-autoupdate", "run"]
    env_file: ./tunnel.env
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
EOF
	printf 'TUNNEL_TOKEN=paste-the-token-here\n' >protect/tunnel.env
	chmod 600 protect/tunnel.env
	say "Generated protect/compose.yaml and protect/tunnel.env. Now, in the Cloudflare dashboard:"
	cat <<EOF
 1. Zero Trust -> Networks -> Tunnels -> Create a tunnel -> Cloudflared. Copy the token from the
    install command (the long string after --token) into protect/tunnel.env.
 2. Tunnel -> Public hostname -> Add: $HOST, service HTTP, URL 127.0.0.1:$PORT
 3. Zero Trust -> Access -> Applications -> Add -> Self-hosted:
      a) $HOST            policy "Allow", include Emails = your address
      b) $HOST/share      policy action "Bypass", include Everyone   (share links)
 4. Optional hardening: tunnel's public hostname -> Additional application settings -> Access ->
    "Protect with Access" (select app a). Then cloudflared itself rejects requests without login.
 5. docker compose -f protect/compose.yaml up -d
 6. sh scripts/test-protection.sh $PUBLIC_URL
EOF
	;;

2) # ------------------------------------------------------------------ Caddy + Cloudflare (proxied)
	ask team "Cloudflare Access team domain (Zero Trust -> Settings)" "yourteam.cloudflareaccess.com"
	ask aud "AUD tag of the Access app for $HOST (create the app first, see step 2 below; Enter = fill in later)" "PASTE-AUD-HERE"
	ask email "Email for Let's Encrypt" ""
	command -v curl >/dev/null || die "curl is needed"
	curl -fsS https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem -o protect/cloudflare-origin-pull-ca.pem ||
		die "couldn't download Cloudflare's origin-pull CA"
	cat >protect/Dockerfile <<'EOF'
# Caddy with two plugins: caddy-jwt (verifies the Cloudflare Access login token) and
# caddy-dns/cloudflare (certificates via DNS, works behind Cloudflare's proxy).
FROM caddy:2.11.4-builder AS build
ENV GOMAXPROCS=2
RUN xcaddy build v2.11.4 --with github.com/ggicci/caddy-jwt@v1.4.0 --with github.com/caddy-dns/cloudflare@v0.2.4 --output /caddy
FROM caddy:2.11.4
COPY --from=build /caddy /usr/bin/caddy
EOF
	cat >protect/Caddyfile <<EOF
{
	email $email
}

$HOST {
	tls {
		# Certificate via DNS-01 (Cloudflare API token with Zone:DNS:Edit, in protect/cloudflare.env).
		dns cloudflare {env.CF_API_TOKEN}
		resolvers 1.1.1.1 1.0.0.1
		# Authenticated Origin Pulls: only Cloudflare can connect; direct connections to your IP fail.
		client_auth {
			mode require_and_verify
			trust_pool file /etc/caddy/cloudflare-origin-pull-ca.pem
		}
	}
	# Share links: public (Access "Bypass" app on /share). Strict match: nothing else is ever public.
	@share {
		path_regexp ^/share/[A-Za-z0-9_-]{22}(/.*)?$
		not path_regexp (^|/)\\.\\.?(/|$)
		not expression \`{http.request.uri}.matches("(?i)%2e|%2f|%5c")\`
	}
	route {
		handle @share {
			reverse_proxy 127.0.0.1:$PORT
		}
		handle {
			# Every other request must carry a valid Access login token for this app. If an Access
			# policy is ever misconfigured, this still fails closed (401).
			route {
				jwtauth {
					jwk_url https://$team/cdn-cgi/access/certs
					sign_alg RS256
					from_header Cf-Access-Jwt-Assertion
					issuer_whitelist https://$team
					audience_whitelist $aud
					user_claims email
				}
				reverse_proxy 127.0.0.1:$PORT
			}
		}
	}
}
EOF
	caddy_compose "    build: .
    image: local/caddy-cloudflare-jwt:2.11.4
    env_file: ./cloudflare.env" >protect/compose.yaml
	sed -i 's#      - ./Caddyfile:/etc/caddy/Caddyfile:ro#      - ./Caddyfile:/etc/caddy/Caddyfile:ro\n      - ./cloudflare-origin-pull-ca.pem:/etc/caddy/cloudflare-origin-pull-ca.pem:ro#' protect/compose.yaml
	printf 'CF_API_TOKEN=paste-a-token-with-Zone.DNS.Edit-here\n' >protect/cloudflare.env
	chmod 600 protect/cloudflare.env
	say "Generated protect/{Dockerfile,Caddyfile,compose.yaml,cloudflare.env,cloudflare-origin-pull-ca.pem}. Now:"
	cat <<EOF
 1. Cloudflare DNS: A/AAAA record $HOST -> this server's IP, Proxied (orange cloud).
    SSL/TLS -> Overview: "Full (strict)". SSL/TLS -> Origin Server: enable "Authenticated Origin Pulls".
 2. Zero Trust -> Access -> Applications -> Add -> Self-hosted:
      a) $HOST            policy "Allow", include Emails = your address
                          -> copy its "Application Audience (AUD) Tag" into protect/Caddyfile (audience_whitelist)
      b) $HOST/share      policy action "Bypass", include Everyone   (share links)
 3. My Profile -> API Tokens -> Create token "Edit zone DNS" for your zone; put it into protect/cloudflare.env
 4. Ports 80 and 443 must be free on this server (if you already run Caddy, copy the site block from
    protect/Caddyfile into your Caddyfile instead and build your Caddy with the two plugins).
 5. docker compose -f protect/compose.yaml up -d --build    (the first build compiles Caddy: a few minutes)
 6. sh scripts/test-protection.sh $PUBLIC_URL
EOF
	;;

3) # ------------------------------------------------------------------ Caddy + basic auth
	ask user "Login name" "me"
	pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
	hash=$(docker run --rm "$CADDY" caddy hash-password --plaintext "$pw")
	caddy_site "		basic_auth {
			$user $hash
		}" >protect/Caddyfile
	caddy_compose "    image: $CADDY" >protect/compose.yaml
	say "Generated protect/Caddyfile and protect/compose.yaml."
	printf '\n  Login: \033[1m%s\033[0m   Password: \033[1m%s\033[0m\n  Save this password in your password manager now; it is not stored anywhere else.\n' "$user" "$pw"
	unset pw
	cat <<EOF

 1. DNS: $HOST -> this server's public IP. Ports 80 and 443 open and free (Caddy gets the certificate).
    If you already run Caddy, copy the site block from protect/Caddyfile into your Caddyfile instead.
 2. docker compose -f protect/compose.yaml up -d
 3. sh scripts/test-protection.sh $PUBLIC_URL
Basic auth has no 2FA and no lockout; the long random password is what protects you.
EOF
	;;

4) # ------------------------------------------------------------------ Tailscale only
	say "Tailscale only: run on this server (needs Tailscale installed and logged in):"
	cat <<EOF
   sudo tailscale serve --bg --https=443 http://127.0.0.1:$PORT
   tailscale serve status        # shows your https://<machine>.<tailnet>.ts.net URL

 Then set PUBLIC_URL in .env to that URL and run: docker compose up -d
 Share links work only for people in your tailnet. Do NOT use 'tailscale funnel' for this port:
 it would make the editor public too.
EOF
	;;

5) # ------------------------------------------------------------------ Caddy + SSO proxy
	ask fa "Address of your auth service's forward-auth endpoint" "127.0.0.1:9091"
	ask uri "Its forward-auth path (Authelia: /api/authz/forward-auth)" "/api/authz/forward-auth"
	caddy_site "		forward_auth $fa {
			uri $uri
			copy_headers Remote-User Remote-Email
		}" >protect/Caddyfile
	caddy_compose "    image: $CADDY" >protect/compose.yaml
	say "Generated protect/Caddyfile and protect/compose.yaml."
	cat <<EOF
 1. In your auth service, allow ONLY your own user for $HOST (and enable 2FA).
 2. DNS: $HOST -> this server; ports 80/443 free (or copy the site block into your existing Caddy).
 3. docker compose -f protect/compose.yaml up -d
 4. sh scripts/test-protection.sh $PUBLIC_URL
EOF
	;;
*) die "unknown choice '$choice'" ;;
esac
