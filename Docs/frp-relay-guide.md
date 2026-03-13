# CodeRover + FRP Relay Guide

This guide shows how to expose the local CodeRover bridge through [`frp`](https://github.com/fatedier/frp) when Tailscale is too slow or unstable for interactive use.

The goal is:

1. `coderover` still runs locally on your Mac.
2. `frpc` forwards a public TCP port from your VPS back to the local bridge port on your Mac.
3. CodeRover advertises that public relay address in the pairing QR.
4. The mobile app can pick the relay candidate during pairing or later in transport settings.

## Why TCP mode

CodeRover exposes a WebSocket endpoint on a path like `/bridge/<bridgeId>`, but the transport itself is still ordinary WebSocket-over-TCP. For `frp`, the safest setup is a plain `tcp` proxy that forwards the whole socket stream unchanged.

Do not use `http`, `https`, or path-rewriting proxies for the bridge unless you are intentionally terminating and re-originating WebSocket traffic and you understand the upgrade requirements.

## Recommended topology

```text
iPhone / Android app
        |
        | wss://relay.example.com:8765/bridge/<bridgeId>
        v
   VPS public IP / domain
        |
        | frps (server)
        v
     frpc on your Mac
        |
        | ws://127.0.0.1:8765/bridge/<bridgeId>
        v
   coderover up / npm start
```

## Prerequisites

- A VPS with a public IPv4 address
- A domain name pointing at that VPS, such as `relay.example.com`
- `frp` installed on both the VPS and your Mac
- CodeRover bridge already working locally with `cd coderover-bridge && npm start`
- Port planning:
  - `7000/tcp` for `frps` control channel
  - `8765/tcp` for the public CodeRover relay port
  - `7500/tcp` optional, only if you want the `frps` dashboard

## Version choice

Prefer the current stable `frp` release from the official project releases page:

- GitHub: [fatedier/frp](https://github.com/fatedier/frp)
- Releases: [github.com/fatedier/frp/releases](https://github.com/fatedier/frp/releases)
- Docs: [gofrp.org](https://gofrp.org/en/docs/)

This guide uses the current TOML-style configuration supported by modern `frp` releases.

## Step 1: VPS server setup

### 1. Download and install `frps`

On the VPS, install the latest release package for your architecture from the official release page.

Place the binary somewhere standard, for example:

```sh
sudo install -m 755 frps /usr/local/bin/frps
```

### 2. Create `frps.toml`

Create `/etc/frp/frps.toml`:

```toml
bindPort = 7000

auth.method = "token"
auth.token = "replace-with-a-long-random-secret"

transport.tls.force = true

webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "replace-with-another-random-secret"
```

Notes:

- `bindPort` is the control port used by `frpc`.
- `auth.token` must match on the client side.
- `transport.tls.force = true` makes the client-server `frp` control channel require TLS.
- `webServer.*` is optional. Keep it bound to `127.0.0.1` unless you intentionally reverse-proxy it.

### 3. Open firewall ports

Allow at least:

```sh
sudo ufw allow 7000/tcp
sudo ufw allow 8765/tcp
```

If you use another firewall or cloud security group, open the same ports there too.

### 4. Run `frps`

For a quick manual test:

```sh
sudo /usr/local/bin/frps -c /etc/frp/frps.toml
```

If it starts cleanly, convert it to a systemd service.

### 5. Create a systemd service

Create `/etc/systemd/system/frps.service`:

```ini
[Unit]
Description=frp server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now frps
sudo systemctl status frps
```

## Step 2: Mac local setup

### 1. Confirm CodeRover local bridge works

On your Mac:

```sh
cd coderover-bridge
npm install
npm start
```

By default the bridge listens on local port `8765`.

### 2. Create `frpc.toml`

Create a local config such as `~/frp/frpc.toml`:

```toml
serverAddr = "relay.example.com"
serverPort = 7000

auth.method = "token"
auth.token = "replace-with-a-long-random-secret"

transport.tls.enable = true

[[proxies]]
name = "coderover-bridge"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8765
remotePort = 8765
```

Notes:

- `serverAddr` is your VPS domain or IP.
- `localIP` should stay `127.0.0.1` because the CodeRover bridge runs on the same Mac.
- `type = "tcp"` is the important part for CodeRover.
- `remotePort = 8765` means your VPS will expose `relay.example.com:8765` publicly.

### 3. Start `frpc`

Manual run:

```sh
/path/to/frpc -c ~/frp/frpc.toml
```

If this succeeds, keep it alive with `launchd`, `brew services`, or your own supervisor.

## Step 3: Advertise the relay address in the pairing QR

Once the relay works, start CodeRover with an explicit relay candidate:

```sh
cd /Users/sofent/work/coderover/coderover-bridge
CODEROVER_RELAY_URL=wss://relay.example.com:8765 npm start
```

You can also advertise multiple relay candidates:

```sh
CODEROVER_RELAY_URLS=wss://relay-a.example.com:8765,wss://relay-b.example.com:8765 npm start
```

Behavior:

- CodeRover still auto-adds local LAN candidates.
- It still auto-adds Tailscale candidates if available.
- The explicit relay URLs are appended to the QR payload as additional transport candidates.
- If the QR contains more than one candidate, the mobile app can choose the correct one.

## Copyable sample

This section is the shortest path if you just want a ready-made template and then replace the placeholders.

Assumptions in this sample:

- VPS domain: `relay.example.com`
- VPS public relay port: `8765`
- `frps` control port: `7000`
- CodeRover local bridge port on the Mac: `8765`
- `frp` auth token: `replace-with-a-very-long-random-token`

### VPS: `/etc/frp/frps.toml`

```toml
bindPort = 7000

auth.method = "token"
auth.token = "replace-with-a-very-long-random-token"

transport.tls.force = true

webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "replace-with-a-second-long-random-secret"
```

### VPS: `/etc/systemd/system/frps.service`

```ini
[Unit]
Description=frp server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### VPS: firewall

```sh
sudo ufw allow 7000/tcp
sudo ufw allow 8765/tcp
sudo systemctl daemon-reload
sudo systemctl enable --now frps
sudo systemctl status frps
```

### Mac: `~/frp/frpc.toml`

```toml
serverAddr = "relay.example.com"
serverPort = 7000

auth.method = "token"
auth.token = "replace-with-a-very-long-random-token"

transport.tls.enable = true

[[proxies]]
name = "coderover-bridge"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8765
remotePort = 8765
```

### Mac: start `frpc`

```sh
/path/to/frpc -c ~/frp/frpc.toml
```

### Mac: start CodeRover and advertise the relay URL in QR

```sh
cd /Users/sofent/work/coderover/coderover-bridge
CODEROVER_RELAY_URL=wss://relay.example.com:8765 npm start
```

### End-to-end quick check

On the Mac:

```sh
curl -i http://127.0.0.1:8765/bridge/test
```

From another public-network machine:

```sh
curl -i http://relay.example.com:8765/bridge/test
```

Both should return `426 Upgrade Required`.

### If you want two relay entries in the QR

```sh
cd /Users/sofent/work/coderover/coderover-bridge
CODEROVER_RELAY_URLS=wss://relay-a.example.com:8765,wss://relay-b.example.com:8765 npm start
```

### If your local CodeRover bridge port is not `8765`

Keep the `frpc` `localPort` and CodeRover `CODEROVER_LOCAL_PORT` aligned:

```sh
cd /Users/sofent/work/coderover/coderover-bridge
CODEROVER_LOCAL_PORT=9876 CODEROVER_RELAY_URL=wss://relay.example.com:8765 npm start
```

Then change Mac `frpc.toml` accordingly:

```toml
[[proxies]]
name = "coderover-bridge"
type = "tcp"
localIP = "127.0.0.1"
localPort = 9876
remotePort = 8765
```

## Step 4: Pair from the mobile app

1. Open CodeRover on the phone.
2. Scan the QR generated by `npm start` or `coderover up`.
3. If the QR advertises multiple transports, choose the relay or local address you want.
4. After pairing, you can switch transport preference from app settings if needed.

## Step 5: Verification checklist

### Verify local bridge

On the Mac:

```sh
curl -i http://127.0.0.1:8765/bridge/test
```

Expected result: HTTP `426 Upgrade Required`. That confirms the local CodeRover HTTP server is up.

### Verify `frpc` to `frps`

Check logs:

```sh
tail -f ~/frp/frpc.log
sudo journalctl -u frps -f
```

You want to see the proxy connect successfully and bind `remotePort = 8765`.

### Verify public relay reachability

From another machine on the public internet:

```sh
curl -i http://relay.example.com:8765/bridge/test
```

Expected result: still HTTP `426 Upgrade Required`.

That means the TCP tunnel is passing the CodeRover bridge endpoint through unchanged.

## Common failure cases

### 1. QR scan succeeds, but the app cannot connect

Check:

- `frpc` is running on the Mac
- `frps` is running on the VPS
- `remotePort` is open in both VPS firewall and provider security group
- `CODEROVER_RELAY_URL` exactly matches the public address and port exposed by `frp`
- The URL scheme matches the way users connect:
  - use `wss://` if users connect through TLS
  - use `ws://` only for plain-text testing on trusted networks

### 2. Public relay is reachable with `curl`, but the app still fails

Check whether an upstream reverse proxy or CDN is interfering with WebSocket upgrade or long-lived connections. The simplest setup is direct `frp tcp` forwarding from the public port to the local CodeRover port.

### 3. Local works, relay does not

This almost always means one of:

- wrong `auth.token`
- wrong VPS firewall rules
- wrong `remotePort`
- wrong domain DNS
- `CODEROVER_RELAY_URL` points to a URL that `frps` is not actually exposing

### 4. You used `https` or `http` proxy mode

Switch back to `tcp` first. CodeRover is a WebSocket bridge, and `tcp` is the least surprising transport for `frp`.

## Operational recommendations

- Use a dedicated domain for the relay, for example `relay.example.com`.
- Use long random tokens for `frp` auth.
- Keep `frps` dashboard bound to localhost unless you explicitly protect and publish it.
- Prefer `wss://` for the advertised relay URL in QR codes.
- Keep local bridge candidates in the QR even if you use relay; they are often faster on the same LAN.
- If you want a stable public setup, run `frps` under systemd and `frpc` under `launchd` or another local supervisor.

## Minimal working example

VPS `/etc/frp/frps.toml`:

```toml
bindPort = 7000
auth.method = "token"
auth.token = "change-me"
transport.tls.force = true
```

Mac `~/frp/frpc.toml`:

```toml
serverAddr = "relay.example.com"
serverPort = 7000
auth.method = "token"
auth.token = "change-me"
transport.tls.enable = true

[[proxies]]
name = "coderover-bridge"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8765
remotePort = 8765
```

Mac startup command:

```sh
cd coderover-bridge
CODEROVER_RELAY_URL=wss://relay.example.com:8765 npm start
```

## References

- Official repository: [fatedier/frp](https://github.com/fatedier/frp)
- Official docs: [gofrp.org](https://gofrp.org/en/docs/)
- Authentication docs: [Authentication](https://gofrp.org/en/docs/features/common/authentication/)
- Server management docs: [Server Manage](https://gofrp.org/en/docs/features/common/server-manage/)
