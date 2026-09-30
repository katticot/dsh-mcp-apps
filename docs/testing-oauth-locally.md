# Testing OAuth Locally in `dsh-mcp-apps`

This guide details the complete, layered testing procedure for verifying OAuth 2.0 authentication in `dsh-mcp-apps`, from fast unit tests up to a full end-to-end browser consent round-trip.

---

## Overview of Testing Layers

1. [Layer 1: Fast Automated Checks](#layer-1-fast-automated-checks) (Unit & regression tests, ~30s, no server needed)
2. [Layer 2: Security Spot Checks](#layer-2-security-spot-checks) (Negative tests, Host header immunity, permissions)
3. [Layer 3A: Quick Local E2E with Mock Provider](#layer-3a-quick-local-e2e-with-mock-provider) (SDK In-Memory Fixture, zero credentials)
4. [Layer 3B: Full Production E2E with Powerhive](#layer-3b-full-production-e2e-with-powerhive) (Live Google IdP + DCR + Streamable HTTP)
5. [Layer 4: Troubleshooting & Diagnostics](#layer-4-troubleshooting--diagnostics)

---

## Layer 1: Fast Automated Checks

Run these from the worktree (`.claude/worktrees/agent-aa2f00e89bc3b22ea` or repository root):

```bash
pnpm install
pnpm typecheck
pnpm test                          # Full suite (178 tests)
pnpm test -- oauth                 # Target only oauth-token-store & oauth-server-pool
pnpm build
```

### What This Protects Against
* **`tests/oauth-server-pool.spec.ts`**: Pins the critical security fix that `redirect_uri` is constructed **exclusively from `Config.externalUrl`** and remains identical across both Dynamic Client Registration (RFC 7591), `/oauth/authorize`, and token exchange (`/oauth/token`).
* **`tests/oauth-token-store.spec.ts`**: Verifies atomic writes, directory creation with `0700`, file creation with `0600`, and automatic chmod enforcement on pre-existing loose files.

---

## Layer 2: Security Spot Checks

These checks verify error handling, origin isolation, and file permissions without requiring a full IdP flow:

### 1. Mandatory `externalUrl` Check
Configure a server in `cordis.patch.yml` with `oauth: true` but omit `externalUrl`. Triggering `/api/mcp-apps/oauth/authorize` must fail immediately with:
> `OAuth requires 'externalUrl' to be configured on this plugin`
It must not hang or silently fall back to request headers.

### 2. Host Header Injection Immunity
With `externalUrl: 'http://localhost:3080'` configured, trigger an authorization request while spoofing the `Host` header:
```bash
curl -s -X POST http://127.0.0.1:3080/api/mcp-apps/oauth/authorize \
  -H "Host: evil.example.com" \
  -H "Content-Type: application/json" \
  -d '{"server":"powerhive"}'
```
Inspect the returned `authorizeUrl`: the `redirect_uri` parameter must strictly match `http://localhost:3080/...` and remain completely unaffected by `evil.example.com`.

### 3. Redaction on Discovery Failure
Point an `oauth: true` server at a dummy URL with no `/.well-known/oauth-protected-resource`:
```yaml
servers:
  dummy-test:
    transport: streamable-http
    url: 'http://127.0.0.1:9999/mcp'
    oauth: true
```
Call `authorize` and verify the returned error message redacts internals and leaks no sensitive environment or token data.

### 4. Filesystem Permissions Audit
Inspect the local token directory created by DSH:
```bash
ls -la ~/.dsh/mcp-apps/oauth/
```
* Directory permissions must be `drwx------` (`0700`).
* Token files must be `-rw-------` (`0600`).
* If you manually loosen a token file (`chmod 644 ~/.dsh/mcp-apps/oauth/<server>.json`), the next write or token refresh must automatically reset it back to `0600`.

---

## Layer 3A: Quick Local E2E with Mock Provider

If you want to test the full browser popup, authorization exchange, and auto-closing without needing any real cloud credentials (Google, GitHub, Linear):

### 1. Start the Bundled In-Memory OAuth Provider
The `@modelcontextprotocol/sdk` installed in `node_modules` includes a standalone OAuth mock server:

```bash
node node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/demoInMemoryOAuthProvider.js
```
*(Note the port it binds to, typically `3001` or `8080`).*

### 2. Configure DSH Profile
In `~/.dsh/profiles/web/cordis.patch.yml`:
```yaml
- id: mcp-apps
  name: 'dsh-mcp-apps'
  config:
    externalUrl: 'http://localhost:3080'
    servers:
      mock-oauth:
        transport: streamable-http
        url: 'http://localhost:<PORT>/mcp'
        oauth: true
```

### 3. Test Flow
1. Run `dsh --profile web`.
2. Open `http://localhost:3080`.
3. In the plugin status panel, `mock-oauth` will display **● Requires Auth**.
4. Click **Connect Account** -> Approve consent in popup -> Popup closes -> Status flips to **● Connected**.

---

## Layer 3B: Full Production E2E with Powerhive

Use this layer to verify real-world dynamic client registration (RFC 7591), S256 PKCE, loopback redirects (RFC 8252), and Google Workspace identity delegation.

### Option 1: Live Remote Powerhive Deployment
If testing against the live instance (`https://mcp.srv1156700.hstgr.cloud/mcp`):

1. **Configure `~/.dsh/profiles/web/cordis.patch.yml`**:
   ```yaml
   - id: mcp-apps
     name: 'dsh-mcp-apps'
     config:
       externalUrl: 'http://localhost:3080'
       servers:
         powerhive:
           transport: streamable-http
           url: 'https://mcp.srv1156700.hstgr.cloud/mcp'
           oauth: true
           allowAppToolCalls: allow
   ```

2. **Start DSH**:
   ```bash
   dsh --profile web
   ```

3. **Open the Web UI** (`http://127.0.0.1:3080`).
4. Find `powerhive` in the status panel:
   * Status should display **● Requires Auth** with a **Connect Account** button.
5. Click **Connect Account**:
   * DSH discovers metadata from `/.well-known/oauth-protected-resource`.
   * DSH dynamically registers a client at `POST /oauth/register`.
   * A popup opens pointing to Powerhive's `/oauth/authorize`, which redirects to Google login.
   * Sign in with your Workspace Google account.
   * Google returns the auth code to Powerhive, which redirects back to DSH callback (`http://localhost:3080/api/mcp-apps/oauth/callback?server=powerhive&...`).
   * DSH completes token exchange at `POST /oauth/token` and writes tokens to `~/.dsh/mcp-apps/oauth/powerhive.json`.
   * The popup automatically closes.
   * The status row updates dynamically to **● Connected** without manual page refresh.

### Option 2: Local `powerhive-mcp-go` Instance
To run Powerhive entirely locally on your machine:

1. **Set required environment in `/Users/keita/Developer/experiments/powerhive-mcp-go`**:
   ```bash
   export PUBLIC_URL="http://localhost:8095"
   export PORT="8095"
   export POWERHIVE_DATA_DIR="/tmp/powerhive-data"
   export GOOGLE_WORKSPACE_DOMAIN="yourdomain.com"
   export GOOGLE_CLIENT_ID="<your-id>.apps.googleusercontent.com"
   export GOOGLE_CLIENT_SECRET="<your-secret>"
   export CLAUDE_CLIENT_ID="test-static-client"
   export ALLOWED_ORIGINS="http://localhost:3080"
   ```
   *(Ensure `http://localhost:8095/oauth/google/callback` is registered in Google Cloud Console's authorized redirect URIs).*

2. **Start the Go MCP server**:
   ```bash
   go run main.go
   ```

3. **Update `cordis.patch.yml` URL to `http://localhost:8095/mcp`** and repeat the connection steps above.

---

## Verification Checklist

| Step | Action | Expected Result |
| :--- | :--- | :--- |
| **1. Initial Status** | Load DSH UI | Server shows `● Requires Auth` with a `Connect Account` button |
| **2. Auth Flow** | Click `Connect Account` | Browser opens popup to IdP consent |
| **3. Token Persistence** | Complete login | Popup self-closes; UI status turns `● Connected`; token file exists at `~/.dsh/mcp-apps/oauth/<server>.json` (`0600`) |
| **4. Tool Execution** | Invoke a tool | Tool calls succeed with `Authorization: Bearer <token>` injected |
| **5. Session Reuse** | Restart DSH (`Ctrl-C`, re-run) | Server reconnects automatically on startup using saved token; no button click needed |
| **6. Token Revocation** | Delete token JSON & restart | Server gracefully reverts to `● Requires Auth` without throwing fatal errors |
