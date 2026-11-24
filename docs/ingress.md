# Protection setups: HTTPS and a login in front of open-slide-server

open-slide-server listens on `http://127.0.0.1:PORT` (`.env`) and does **no login**. What happens if it's
reachable without one is described in the [README](../README.md#protection-setups). In short: anyone can
use your Claude subscription, your decks and your GitHub access.

**Every setup must:**
1. Serve HTTPS and forward to `http://127.0.0.1:PORT`. Keep the `Host` header and allow WebSockets (the editor uses them).
2. Require **your** login for every path, **except** paths starting with `/share/`, which are the public share links.
3. Let only you in. Anyone who gets past the login has full control: editor, agent, GitHub sync.

After setting it up, run the test from the README.

---

## A) Cloudflare Tunnel + Cloudflare Access

*Reachable from anywhere, no open ports, free plan. Needs a domain using Cloudflare DNS.*

1. **Install cloudflared** on the server, following Cloudflare's docs for your distro.
2. **Create the tunnel** in Zero Trust → Networks → Tunnels → *Create a tunnel* (Cloudflared). Run the install command it shows. Then add a **public hostname**: `slides.example.com`, service `HTTP`, URL `127.0.0.1:8080` (your `PORT`).
3. **Add Access applications** under Zero Trust → Access → Applications → *Add* → *Self-hosted*:
   - **`slides.example.com`**: policy *Allow*, include *Emails* = your address. Login methods: one-time PIN, or Google or GitHub.
   - **`slides.example.com/share`**: policy action **Bypass**, include *Everyone*. These are the share links.
   - *Optional:* **`slides.example.com/slides/d/<deck>`**: allow the people who should see that published deck.
4. **Optional hardening:** in the tunnel's public hostname → *Additional application settings* → *Access*, enable **Protect with Access** (select the host app). Then cloudflared itself rejects requests without a valid Access token, even if an Access policy is misconfigured.
5. Run the README test.

## B) Tailscale only

*Only your own devices can reach it, nothing on the public internet. ~5 minutes if you use Tailscale.*

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
```

- The URL is `https://<machine>.<tailnet>.ts.net`. Set it as `PUBLIC_URL` in `.env`, then run `docker compose up -d`.
- Restrict who in your tailnet may reach this machine with tailnet ACLs.
- Share links work only for people in your tailnet. If you need public share links, choose another setup.
- **Don't enable Tailscale Funnel for this port.** Funnel makes the whole port public, including the editor, not just `/share/`.

## C) Caddy + basic auth

*Quick start on a server with a public IP. One strong password, no extra service.*

```sh
caddy hash-password    # enter a long random password from your password manager
```

```
slides.example.com {
	@share path /share/*
	handle @share {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		basic_auth {
			you $2a$14$...paste-the-hash...
		}
		reverse_proxy 127.0.0.1:8080
	}
}
```

- Caddy gets the HTTPS certificate automatically: ports 80 and 443 must be open, and DNS must point to the server.
- Basic auth has no 2FA and no lockout, so use a long random password (20+ characters).
- The browser remembers it per session.

## D) Caddy / nginx + an SSO proxy (Authelia, authentik, oauth2-proxy)

*2FA and single sign-on without Cloudflare, if you run (or want) such a service.*

Example with Caddy and Authelia (`forward_auth`):

```
slides.example.com {
	@share path /share/*
	handle @share {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		forward_auth 127.0.0.1:9091 {
			uri /api/authz/forward-auth
			copy_headers Remote-User Remote-Email
		}
		reverse_proxy 127.0.0.1:8080
	}
}
```

In the auth service, allow only your own user for this host.

---

## Host firewall

- The containers with internet access (worker, deps, claude-proxy) can reach services on your host's network addresses, like any Docker container.
- If the host runs services that listen on all interfaces and trust local networks, restrict them with your firewall, e.g. iptables `DOCKER-USER` rules or ufw.
- The editor sandbox can't reach the host at all.
- Keep `BIND=127.0.0.1`. If your proxy runs on another machine and you must bind elsewhere, allow only that machine in the firewall.
