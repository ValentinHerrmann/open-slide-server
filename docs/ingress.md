# Putting HTTPS and a login in front (suggestions)

open-slide-server listens on `127.0.0.1:PORT` (from `.env`) and does **no login**. Everything from
there to the internet is up to you.

**Requirements for whatever you put in front:**
- HTTPS for your host, forwarding to `http://127.0.0.1:PORT`. Keep the `Host` header and allow WebSockets (the editor uses them).
- **Login required for everything except paths starting with `/share/`.** Share links are meant to work without login.
- Only you should get `/`, `/editor/` and `/slides/`. Anyone who gets through can use the editor and your Claude subscription.

Some setups that work well:

## Cloudflare Tunnel + Cloudflare Access

No open ports and no certificates on your machine.

1. **Tunnel:** in Zero Trust → Networks → Tunnels, create a tunnel. Install `cloudflared` on the host, with public hostname `slides.example.com` → `http://127.0.0.1:8080`.
2. **Access applications** (Zero Trust → Access → Applications → Self-hosted):
   - `slides.example.com`: Allow, only your email.
   - `slides.example.com/share`: **Bypass**, Everyone.
   - Optional: `slides.example.com/slides/d/<deck>` for presenters of that deck.
3. Optional hardening: verify the Access JWT (`Cf-Access-Jwt-Assertion`) on the host, e.g. with the tunnel's "Protect with Access" origin setting. Then a mistake in the Access policies doesn't expose the editor.

## Caddy / nginx with an auth proxy

Examples: oauth2-proxy, Authelia, authentik. With Caddy:

```
slides.example.com {
	@share path /share/*
	handle @share {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		forward_auth 127.0.0.1:9091 {
			uri /api/verify?rd=https://auth.example.com
		}
		reverse_proxy 127.0.0.1:8080
	}
}
```

## Tailscale only

`tailscale serve --bg --https=443 http://127.0.0.1:8080` makes it reachable only inside your tailnet. Share links then only work for people in your tailnet.

## Host firewall

- The containers with internet access (worker, deps, claude-proxy) can reach services on your host's network addresses, as any Docker container can.
- If the host runs services that listen on all interfaces and trust local networks, restrict them with your firewall (e.g. iptables `DOCKER-USER` rules).
- The editor sandbox can't reach the host at all.
