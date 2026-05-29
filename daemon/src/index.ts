// OpenCode Remote — Companion Daemon
// Starts OpenCode, generates QR code, monitors health.
// Keep this THIN. OpenCode does the heavy lifting.

import { spawn, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

// ─── Configuration ──────────────────────────────────────────────────────────

const DATA_DIR = path.join(
  process.env.HOME || "/tmp",
  ".local/share/openanywhere"
);
const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const LOG_FILE = path.join(DATA_DIR, "daemon.log");
const PASSWORD_FILE = path.join(DATA_DIR, "password");
const TOKEN_FILE = path.join(DATA_DIR, "token");
const PORT_FILE = path.join(DATA_DIR, "proxy-port");
const PLIST_PATH = path.join(
  process.env.HOME || "/tmp",
  "Library/LaunchAgents/com.vaultzero.openanywhere.plist"
);

// Crash loop protection
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;
const crashTimestamps: number[] = [];

interface Config {
  port: number;
  password: string;
  hostname: string;
}

function generateToken(length = 20): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

function loadToken(): string {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    if (t) return t;
  } catch {}
  const t = generateToken();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

function getTailscaleIP(): string | null {
  try {
    return execSync("tailscale ip -4", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function generatePassword(length = 16): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

function loadPassword(): string {
  try {
    const pw = fs.readFileSync(PASSWORD_FILE, "utf-8").trim();
    if (pw) return pw;
  } catch {
    // File doesn't exist, generate one
  }
  const pw = generatePassword();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PASSWORD_FILE, pw, { mode: 0o600 });
  return pw;
}

function savePID(pid: number): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

function getPID(): number | null {
  try {
    return parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) || null;
  } catch {
    return null;
  }
}

function log(msg: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Log file write failure is non-fatal
  }
}

function isRunning(): boolean {
  const existingPID = getPID();
  if (!existingPID) return false;
  try {
    // Signal 0 checks if process exists without killing it
    process.kill(existingPID, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── LaunchAgent (macOS boot persistence) ────────────────────────────────────

function getOwnPath(): string {
  // Find the openanywhere launcher script
  const paths = [
    path.join(process.env.HOME || "/tmp", ".openanywhere/openanywhere"),
    path.join(process.env.HOME || "/tmp", ".openanywhere/index.js"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: assume the daemon script is running via bun
  return process.argv[1] || "openanywhere";
}

function generatePlist(): string {
  const execPath = getOwnPath();
  const logPath = path.join(DATA_DIR, "launchd.log");
  const errLogPath = path.join(DATA_DIR, "launchd.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.vaultzero.openanywhere</string>
    <key>ProgramArguments</key>
    <array>
        <string>${execPath}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${errLogPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.HOME}/.bun/bin:${process.env.HOME}/.opencode/bin</string>
        <key>HOME</key>
        <string>${process.env.HOME}</string>
    </dict>
</dict>
</plist>`;
}

function cmdInstallBoot(): void {
  if (process.platform !== "darwin") {
    console.log("LaunchAgent is only supported on macOS.");
    console.log("Linux: create a systemd user unit instead.");
    process.exit(1);
  }
  const dir = path.dirname(PLIST_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PLIST_PATH, generatePlist(), { mode: 0o644 });
  try {
    execSync(`launchctl load "${PLIST_PATH}"`, { encoding: "utf-8" });
    console.log("LaunchAgent installed. Daemon will start on boot.");
    console.log(`Plist: ${PLIST_PATH}`);
  } catch (err: any) {
    console.error("Failed to load LaunchAgent:", err.message);
    console.log(`Plist written to ${PLIST_PATH} but not loaded.`);
    console.log(`Run manually: launchctl load "${PLIST_PATH}"`);
  }
}

function cmdUninstallBoot(): void {
  if (fs.existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { encoding: "utf-8" });
    } catch { /* already unloaded */ }
    fs.unlinkSync(PLIST_PATH);
    console.log("LaunchAgent removed.");
  } else {
    console.log("No LaunchAgent installed.");
  }
}

// ─── Banner ─────────────────────────────────────────────────────────────────

type HealthStatus = "ok" | "warn" | "fail";

interface HealthResults {
  opencode: HealthStatus;
  tailscale: HealthStatus;
  proxy: HealthStatus;
  url: string;
}

function checkmark(status: HealthStatus): string {
  switch (status) {
    case "ok": return "✓";
    case "warn": return "⚠";
    case "fail": return "✗";
  }
}

async function runHealthCheck(
  config: Config,
  proxyPort: number,
  tsIP: string,
  token: string
): Promise<HealthResults> {
  const results: HealthResults = {
    opencode: "fail",
    tailscale: "fail",
    proxy: "fail",
    url: `http://${tsIP}:${proxyPort}/?t=${token}`,
  };

  // Check OpenCode
  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${config.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(5000),
    });
    results.opencode = resp.ok ? "ok" : "fail";
  } catch {
    results.opencode = "fail";
  }

  // Check Tailscale
  results.tailscale = tsIP && tsIP !== "localhost" ? "ok" : "warn";

  // Check proxy
  try {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    results.proxy = resp.ok ? "ok" : "fail";
  } catch {
    results.proxy = "fail";
  }

  return results;
}

function printBanner(health: HealthResults, password: string): void {
  const allOk = health.opencode === "ok" && health.tailscale === "ok" && health.proxy === "ok";

  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║      OpenCode Remote — " + (allOk ? "Ready!            ║" : "⚠ Issues Found    ║"));
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");
  console.log(`  ${checkmark(health.opencode)} OpenCode  ${health.opencode === "ok" ? "running" : "not responding"}`);
  console.log(`  ${checkmark(health.tailscale)} Tailscale ${health.tailscale === "ok" ? "connected" : health.tailscale === "warn" ? "no IP — is Tailscale running?" : "disconnected"}`);
  console.log(`  ${checkmark(health.proxy)} Proxy     ${health.proxy === "ok" ? "accessible" : "not reachable"}`);
  console.log("");
  if (allOk) {
    console.log(`  📱  Open on your phone:`);
    console.log(`      ${health.url}`);
    console.log("");
    console.log(`  🔑  Password:  ${password}`);
  } else {
    console.log(`  Troubleshooting:`);
    if (health.opencode !== "ok") console.log(`    • OpenCode failed — try: opencode serve --port 0`);
    if (health.tailscale !== "ok") console.log(`    • Tailscale not connected — try: tailscale up`);
    if (health.proxy !== "ok") console.log(`    • Proxy not reachable — try restarting the daemon`);
  }
  console.log("");
  console.log("  ───────────────────────────────────────────");
  console.log("");
}

// ─── QR Code ────────────────────────────────────────────────────────────────

async function printQR(url: string): Promise<void> {
  // QR codes need ~60 columns minimum to scan reliably
  const columns = process.stdout.columns || 80;
  if (columns < 60) {
    console.log("  [QR code skipped — terminal too narrow]");
    console.log(`  [Use this URL on your phone: ${url}]`);
    return;
  }
  try {
    const qrcode = await import("qrcode-terminal");
    qrcode.default.generate(url, { small: true }, (q: string) => {
      console.log(q);
    });
  } catch {
    console.log(
      "  [QR code unavailable — install qrcode-terminal for QR display]"
    );
    console.log(`  [Use the URL above on your phone: ${url}]`);
  }
}

// ─── OpenCode Process Management ────────────────────────────────────────────

/** Parse the actual port from OpenCode's "listening on" line */
function parseListenPort(line: string): number | null {
  const match = line.match(/listening on http:\/\/[^:]+:(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Start OpenCode and wait until we know the actual port it bound to */
async function startAndWait(config: Config): Promise<{
  process: ReturnType<typeof spawn>;
  url: string;
  actualPort: number;
}> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: config.password,
    };

    const child = spawn(
      "opencode",
      ["serve", "--hostname", config.hostname, "--port", String(config.port)],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );

    let actualPort = config.port;
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (actualPort === 0) {
          reject(new Error("OpenCode did not report its listening port within 30s"));
        } else {
          // We got the port but resolve didn't fire — force it
          const tsIP = getTailscaleIP() || "localhost";
          resolve({ process: child, url: `http://opencode:${config.password}@${tsIP}:${actualPort}/`, actualPort });
        }
      }
    }, 30000);

    let stdoutBuf = "";

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdoutBuf += text;

      for (const line of text.trim().split("\n")) {
        if (line) log(`[opencode] ${line}`);
      }

      // Try to parse the listen port
      if (!resolved) {
        const port = parseListenPort(stdoutBuf);
        if (port !== null && port > 0) {
          actualPort = port;
          resolved = true;
          clearTimeout(timeout);
          const tsIP = getTailscaleIP() || "localhost";
          resolve({
            process: child,
            url: `http://opencode:${config.password}@${tsIP}:${actualPort}/`,
            actualPort,
          });
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (line) log(`[opencode:err] ${line}`);
      }
    });

    child.on("exit", (code, signal) => {
      log(`OpenCode exited (code=${code}, signal=${signal})`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`OpenCode exited prematurely (code=${code})`));
      }
    });

    child.on("error", (err) => {
      log(`OpenCode spawn error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/** Start OpenCode without waiting (used for crash restarts) */
function startOpenCode(config: Config): {
  process: ReturnType<typeof spawn>;
  url: string;
} {
  const env = {
    ...process.env,
    OPENCODE_SERVER_PASSWORD: config.password,
  };

  const child = spawn(
    "opencode",
    ["serve", "--hostname", config.hostname, "--port", String(config.port)],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );

  const tsIP = getTailscaleIP() || "localhost";
  const url = `http://opencode:${config.password}@${tsIP}:${config.port}/`;

  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) {
      if (line) log(`[opencode] ${line}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) {
      if (line) log(`[opencode:err] ${line}`);
    }
  });

  child.on("exit", (code, signal) => {
    log(`OpenCode exited (code=${code}, signal=${signal})`);
  });

  child.on("error", (err) => {
    log(`OpenCode spawn error: ${err.message}`);
  });

  return { process: child, url };
}

// ─── Auth Proxy (replaces simple health server) ─────────────────────────────

let proxyPort: number | null = null;
const activeSessions = new Map<string, number>(); // sessionId → expiry timestamp

function startProxy(
  config: Config,
  childProcess: ReturnType<typeof spawn>
): void {
  const token = loadToken();
  const upstreamHost = "127.0.0.1";
  const upstreamPort = config.port;

  const server = http.createServer((req, res) => {
    // CORS for the OpenCode web UI (it fetches from its own origin)
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/health") {
      const tsIP = getTailscaleIP();
      const status = {
        opencode: childProcess.killed ? "stopped" : "running",
        opencode_pid: childProcess.pid,
        tailscale: tsIP ? "connected" : "disconnected",
        tailscale_ip: tsIP,
        proxy_port: proxyPort,
        upstream_port: upstreamPort,
        uptime_seconds: Math.floor(process.uptime()),
        daemon_pid: process.pid,
      };
      const body = JSON.stringify(status, null, 2);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Check for token in query param → set session cookie
    const queryToken = url.searchParams.get("t");
    if (queryToken && queryToken === token) {
      const sessionId = generateToken(32);
      activeSessions.set(sessionId, Date.now() + 24 * 60 * 60 * 1000); // 24h
      res.setHeader(
        "Set-Cookie",
        `oc_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
      );
      // Redirect to clean URL without token
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    // Check for session cookie
    const cookies = parseCookies(req.headers.cookie || "");
    const sessionId = cookies["oc_session"];
    if (sessionId && activeSessions.has(sessionId)) {
      const expiry = activeSessions.get(sessionId)!;
      if (Date.now() > expiry) {
        activeSessions.delete(sessionId);
      } else {
        // Valid session — proxy to OpenCode with Basic Auth
        forwardToOpenCode(req, res, upstreamHost, upstreamPort, config);
        return;
      }
    }

    // No valid auth — show a simple password entry page
    res.writeHead(401, { "Content-Type": "text/html" });
    res.end(AUTH_PAGE);
  });

  // Listen on 0.0.0.0 so it's reachable via Tailscale IP
  server.listen(0, "0.0.0.0", () => {
    const addr = server.address() as AddressInfo;
    proxyPort = addr.port;
    fs.writeFileSync(PORT_FILE, String(addr.port));
    log(`Proxy: http://0.0.0.0:${addr.port}`);
  });
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...val] = part.trim().split("=");
    if (key) cookies[key] = val.join("=");
  }
  return cookies;
}

function forwardToOpenCode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamHost: string,
  upstreamPort: number,
  config: Config
): void {
  const auth = Buffer.from(`opencode:${config.password}`).toString("base64");

  // Build upstream path (strip ?t= if present)
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  url.searchParams.delete("t");
  const upstreamPath = url.pathname + url.search;

  const options: http.RequestOptions = {
    hostname: upstreamHost,
    port: upstreamPort,
    path: upstreamPath,
    method: req.method,
    headers: { ...req.headers } as Record<string, string | string[] | undefined>,
  };

  // Set auth and upstream host
  const h = options.headers as Record<string, string | string[] | undefined>;
  h["host"] = `${upstreamHost}:${upstreamPort}`;
  h["authorization"] = `Basic ${auth}`;

  // Don't forward hop-by-hop headers
  delete h["connection"];
  delete h["keep-alive"];
  delete h["transfer-encoding"];

  const proxyReq = http.request(options, (proxyRes) => {
    const resHeaders = { ...proxyRes.headers } as Record<string, string | string[] | undefined>;
    delete resHeaders["connection"];
    delete resHeaders["keep-alive"];
    delete resHeaders["transfer-encoding"];

    res.writeHead(proxyRes.statusCode || 200, resHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    log(`Proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("OpenCode is not responding. Try restarting the daemon.");
    }
  });

  req.pipe(proxyReq);
}

const AUTH_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode Remote</title>
<style>
  @property --border-angle {
    syntax: "<angle>";
    initial-value: 0deg;
    inherits: false;
  }

  :root {
    --bg-deep: #050510;
    --card-bg: rgba(12, 15, 32, 0.72);
    --accent-1: #6366f1;
    --accent-2: #8b5cf6;
    --accent-3: #a855f7;
    --text-primary: #e8e8f0;
    --text-secondary: #8c8ca8;
    --text-muted: #5c5c78;
    --input-bg: rgba(8, 10, 22, 0.85);
    --input-border: rgba(99, 102, 241, 0.2);
  }

  * { box-sizing: border-box; margin: 0; padding: 0 }

  body {
    font-family: "SF Pro Display", -apple-system, "Segoe UI", system-ui, sans-serif;
    background: linear-gradient(155deg, #050510 0%, #090c1c 25%, #0d1028 50%, #070a18 75%, #050510 100%);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ── dot grid overlay ── */
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    background-image: radial-gradient(circle, rgba(99, 102, 241, 0.06) 1px, transparent 1px);
    background-size: 28px 28px;
    pointer-events: none;
    z-index: 0;
  }

  /* ── ambient orbs ── */
  .orb {
    position: fixed;
    border-radius: 50%;
    filter: blur(100px);
    pointer-events: none;
    z-index: 0;
    opacity: 0.6;
  }
  .orb-1 {
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.22), transparent 70%);
    top: -15%; left: -12%;
    animation: orb-drift-1 22s ease-in-out infinite alternate;
  }
  .orb-2 {
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(139, 92, 246, 0.18), transparent 70%);
    bottom: -18%; right: -8%;
    animation: orb-drift-2 26s ease-in-out infinite alternate;
  }
  .orb-3 {
    width: 280px; height: 280px;
    background: radial-gradient(circle, rgba(168, 85, 247, 0.14), transparent 70%);
    top: 55%; left: 60%;
    animation: orb-drift-3 19s ease-in-out infinite alternate;
  }

  @keyframes orb-drift-1 {
    0%   { transform: translate(0, 0) scale(1); }
    100% { transform: translate(60px, 40px) scale(1.1); }
  }
  @keyframes orb-drift-2 {
    0%   { transform: translate(0, 0) scale(1); }
    100% { transform: translate(-50px, -30px) scale(1.15); }
  }
  @keyframes orb-drift-3 {
    0%   { transform: translate(0, 0) scale(1); }
    100% { transform: translate(-35px, -45px) scale(1.08); }
  }

  /* ── animated gradient border wrapper ── */
  .card-border {
    --border-angle: 0deg;
    position: relative;
    z-index: 1;
    max-width: 400px;
    width: calc(100% - 40px);
    border-radius: 22px;
    padding: 2px;
    background: conic-gradient(
      from var(--border-angle),
      transparent 0deg,
      transparent 280deg,
      var(--accent-1) 300deg,
      var(--accent-2) 315deg,
      var(--accent-3) 330deg,
      var(--accent-1) 345deg,
      transparent 360deg
    );
    animation: border-sweep 4s linear infinite;
    box-shadow: 0 0 40px rgba(99, 102, 241, 0.08), 0 20px 60px rgba(0, 0, 0, 0.5);
  }

  @keyframes border-sweep {
    to { --border-angle: 360deg; }
  }

  /* ── glass card ── */
  .card {
    position: relative;
    background: var(--card-bg);
    backdrop-filter: blur(24px) saturate(120%);
    -webkit-backdrop-filter: blur(24px) saturate(120%);
    border-radius: 20px;
    padding: 40px 32px 32px;
    text-align: center;
    overflow: hidden;
    z-index: 1;
  }

  /* inner glow at top of card */
  .card::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 20px;
    background: radial-gradient(ellipse at 50% 0%, rgba(99, 102, 241, 0.1) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  /* subtle pulsing card shadow */
  .card::after {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: 20px;
    background: transparent;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    pointer-events: none;
    z-index: 2;
  }

  .card > * { position: relative; z-index: 1 }

  /* ── lock icon ── */
  .lock-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    margin: 0 auto 16px;
    border-radius: 16px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(139, 92, 246, 0.1));
    border: 1px solid rgba(99, 102, 241, 0.2);
    color: var(--accent-2);
    animation: lock-pulse 3s ease-in-out infinite;
  }
  .lock-icon svg { display: block }

  @keyframes lock-pulse {
    0%, 100% { box-shadow: 0 0 12px rgba(99, 102, 241, 0.15); }
    50%      { box-shadow: 0 0 24px rgba(99, 102, 241, 0.3); }
  }

  /* ── typography ── */
  h1 {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.3px;
    margin-bottom: 6px;
    color: var(--text-primary);
  }

  .subtitle {
    color: var(--text-secondary);
    font-size: 14px;
    margin-bottom: 24px;
    line-height: 1.5;
  }

  /* ── form ── */
  form { position: relative; z-index: 1 }

  .input-group {
    position: relative;
    margin-bottom: 14px;
  }

  .input-group input {
    width: 100%;
    padding: 14px 44px 14px 16px;
    border-radius: 12px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text-primary);
    font-size: 15px;
    font-family: inherit;
    text-align: left;
    letter-spacing: 1px;
    outline: none;
    transition: border-color 0.3s ease, box-shadow 0.3s ease, background 0.3s ease;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .input-group input::placeholder {
    color: rgba(232, 232, 240, 0.25);
    letter-spacing: 0;
  }
  .input-group input:focus {
    border-color: var(--accent-1);
    background: rgba(10, 13, 28, 0.95);
    box-shadow:
      0 0 0 3px rgba(99, 102, 241, 0.12),
      0 0 30px rgba(99, 102, 241, 0.08),
      inset 0 0 20px rgba(99, 102, 241, 0.04);
  }

  /* ── password visibility toggle ── */
  .toggle-pw {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: rgba(232, 232, 240, 0.3);
    cursor: pointer;
    padding: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s ease;
    outline: none;
    width: auto;
    border-radius: 8px;
  }
  .toggle-pw:hover { color: rgba(232, 232, 240, 0.7) }
  .toggle-pw:focus-visible {
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.4);
  }

  /* ── submit button ── */
  #submit-btn {
    width: 100%;
    padding: 14px;
    border-radius: 12px;
    border: none;
    background: linear-gradient(135deg, #6366f1 0%, #7c3aed 50%, #8b5cf6 100%);
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    transition: transform 0.2s ease, box-shadow 0.3s ease, opacity 0.3s ease;
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.35);
    letter-spacing: 0.2px;
  }
  #submit-btn::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  #submit-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 28px rgba(99, 102, 241, 0.45);
  }
  #submit-btn:hover::before { opacity: 1 }
  #submit-btn:active {
    transform: translateY(0);
    box-shadow: 0 2px 12px rgba(99, 102, 241, 0.25);
    transition: transform 0.05s ease, box-shadow 0.05s ease;
  }
  #submit-btn:disabled {
    cursor: not-allowed;
    opacity: 0.75;
    transform: none;
    box-shadow: 0 4px 16px rgba(99, 102, 241, 0.2);
  }
  #submit-btn.loading .btn-text { opacity: 0 }
  #submit-btn.loading .btn-spinner { display: block }

  .btn-text {
    transition: opacity 0.2s ease;
  }

  .btn-spinner {
    display: none;
    width: 20px;
    height: 20px;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    position: absolute;
    left: 50%;
    top: 50%;
    margin-left: -10px;
    margin-top: -10px;
    animation: btn-spin 0.65s linear infinite;
  }

  @keyframes btn-spin {
    to { transform: rotate(360deg); }
  }

  /* ── error message ── */
  .error {
    color: #f87171;
    font-size: 13px;
    margin-top: 10px;
    display: none;
    align-items: center;
    justify-content: center;
    gap: 6px;
    animation: error-in 0.35s ease;
  }
  .error.shake {
    animation: error-shake 0.45s ease, error-in 0.35s ease;
  }

  @keyframes error-in {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes error-shake {
    0%, 100% { transform: translateX(0); }
    15%  { transform: translateX(-6px); }
    30%  { transform: translateX(6px); }
    45%  { transform: translateX(-5px); }
    60%  { transform: translateX(5px); }
    75%  { transform: translateX(-3px); }
    90%  { transform: translateX(3px); }
  }

  /* ── secure badge ── */
  .secure-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 16px;
    font-size: 11px;
    font-weight: 500;
    color: rgba(139, 92, 246, 0.6);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .secure-badge svg { opacity: 0.7; flex-shrink: 0 }

  /* ── hint text ── */
  .hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 12px;
    line-height: 1.5;
  }

  /* ── responsive ── */
  @media (max-width: 440px) {
    .card { padding: 28px 20px 24px }
    h1 { font-size: 20px }
    .lock-icon { width: 48px; height: 48px; border-radius: 14px }
  }
</style>
</head>
<body>
<div class="orb orb-1"></div>
<div class="orb orb-2"></div>
<div class="orb orb-3"></div>

<div class="card-border">
  <div class="card">
    <div class="lock-icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2.5" ry="2.5"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        <circle cx="12" cy="16.5" r="1.4" fill="currentColor" stroke="none"/>
      </svg>
    </div>

    <h1>OpenCode Remote</h1>
    <p class="subtitle">Enter the password shown in your terminal</p>

    <form onsubmit="return submitPassword(event)" autocomplete="off">
      <div class="input-group">
        <input type="password" id="pw" placeholder="Password" autofocus autocomplete="off" spellcheck="false">
        <button type="button" class="toggle-pw" onclick="togglePassword()" aria-label="Show password" tabindex="-1">
          <svg id="eye-on" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <svg id="eye-off" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:none">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
            <line x1="9.88" y1="9.88" x2="14.12" y2="14.12"/>
          </svg>
        </button>
      </div>

      <button type="submit" id="submit-btn">
        <span class="btn-text">Connect</span>
        <span class="btn-spinner"></span>
      </button>

      <div class="error" id="err">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span>Invalid password</span>
      </div>
    </form>

    <div class="secure-badge">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      Secure Connection
    </div>

    <p class="hint">Or scan the QR code again for instant access</p>
  </div>
</div>

<script>
var dismissTimer = null;

function togglePassword() {
  var pw = document.getElementById("pw");
  var on = document.getElementById("eye-on");
  var off = document.getElementById("eye-off");
  if (pw.type === "password") {
    pw.type = "text";
    on.style.display = "none";
    off.style.display = "block";
  } else {
    pw.type = "password";
    on.style.display = "block";
    off.style.display = "none";
  }
  pw.focus();
}

async function submitPassword(e) {
  e.preventDefault();
  var btn = document.getElementById("submit-btn");
  var err = document.getElementById("err");
  var pw = document.getElementById("pw");

  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  err.style.display = "none";
  err.classList.remove("shake");

  btn.disabled = true;
  btn.classList.add("loading");

  try {
    var resp = await fetch("/?t=" + encodeURIComponent(pw.value), { redirect: "manual" });
    if (resp.status === 302) {
      window.location.href = resp.headers.get("Location") || "/";
    } else {
      showError();
    }
  } catch (_) {
    showError();
  }
}

function showError() {
  var btn = document.getElementById("submit-btn");
  var err = document.getElementById("err");
  btn.disabled = false;
  btn.classList.remove("loading");
  err.style.display = "flex";
  err.classList.add("shake");
  dismissTimer = setTimeout(function() {
    err.style.display = "none";
    err.classList.remove("shake");
    dismissTimer = null;
  }, 3500);
}
</script>
</body>
</html>`;

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  if (isRunning()) {
    const port = proxyPort || getSavedPort();
    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const status = await res.json();
        console.log(JSON.stringify(status, null, 2));
        return;
      } catch {
        // Fall through to basic status
      }
    }
    console.log("Daemon: running");
  } else {
    console.log("Daemon: stopped");
  }
}

function getSavedPort(): number | null {
  try {
    const p = parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}

function cmdStop(): void {
  const pid = getPID();
  if (!pid) {
    console.log("No running daemon found.");
    process.exit(0);
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (PID ${pid})`);
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
  } catch {
    console.log("Daemon is not running.");
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
  }
}

function cmdUrl(): void {
  const token = loadToken();
  const tsIP = getTailscaleIP() || "localhost";
  const port = proxyPort || getSavedPort();
  // Try to get proxy port from health endpoint
  if (port) {
    fetch(`http://127.0.0.1:${port}/health`)
      .then((r) => r.json())
      .then((s) => console.log(`http://${tsIP}:${s.proxy_port}/?t=${token}`))
      .catch(() => console.log(`http://${tsIP}:${port}/?t=${token}`));
  } else {
    console.log(`http://${tsIP}:0/?t=${token}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2] || "start";

  switch (command) {
    case "start":
      await doStart();
      break;
    case "stop":
      cmdStop();
      break;
    case "status":
      await cmdStatus();
      break;
    case "url":
      cmdUrl();
      break;
    case "password":
      console.log(loadPassword());
      break;
    case "install-boot":
      cmdInstallBoot();
      break;
    case "uninstall-boot":
      cmdUninstallBoot();
      break;
    default:
      console.log("Usage: openanywhere [start|stop|status|url|password|install-boot|uninstall-boot]");
      process.exit(1);
  }
}

async function doStart(): Promise<void> {
  if (isRunning()) {
    console.log("Daemon is already running. Use 'openanywhere status' for details.");
    process.exit(0);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const password = loadPassword();
  const port = parseInt(process.env.OC_PORT || "0", 10) || 0;
  const hostname = process.env.OC_HOSTNAME || "0.0.0.0";

  const config: Config = { port, password, hostname };

  log("Starting OpenCode Remote daemon...");

  // Check prerequisites
  try {
    execSync("which opencode", { encoding: "utf-8" });
  } catch {
    console.error("Error: OpenCode not found. Please install it first:");
    console.error("  curl -fsSL https://opencode.ai/install.sh | bash");
    process.exit(1);
  }

  // Start OpenCode — wait for the actual port to be known
  const { process: child, url, actualPort } = await startAndWait(config);
  savePID(child.pid || 0);

  // Update config with actual port
  const resolvedConfig: Config = { ...config, port: actualPort };

  // Start auth proxy (needs to be running before we display QR)
  startProxy(resolvedConfig, child);

  // Wait briefly for proxy to start
  await new Promise((r) => setTimeout(r, 1000));

  // Run health self-check before displaying banner
  const tsIP = getTailscaleIP() || "localhost";
  const token = loadToken();
  const health = await runHealthCheck(resolvedConfig, proxyPort!, tsIP, token);

  // Display info
  printBanner(health, password);
  if (health.opencode === "ok") {
    await printQR(health.url);
  }

  // Crash recovery with loop protection
  child.on("exit", async (code, signal) => {
    const now = Date.now();
    crashTimestamps.push(now);
    // Purge timestamps older than the window
    while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }

    if (crashTimestamps.length > MAX_CRASHES) {
      log(`OpenCode crashed ${crashTimestamps.length} times in ${CRASH_WINDOW_MS / 1000}s. Giving up.`);
      log("Run 'openanywhere start' to try again.");
      try { fs.unlinkSync(PID_FILE); } catch {}
      process.exit(1);
    }

    const delay = Math.min(crashTimestamps.length * 3000, 15000);
    log(`OpenCode crashed (code=${code}). Restarting in ${delay / 1000}s (attempt ${crashTimestamps.length})...`);
    await new Promise((r) => setTimeout(r, delay));
    const { process: newChild, url: newUrl, actualPort: newPort } = await startAndWait(config);
    savePID(newChild.pid || 0);
    log(`Restarted OpenCode on port ${newPort}.`);
  });

  // Network monitoring: detect Tailscale IP changes
  let lastTSIP = tsIP;
  const netCheckInterval = setInterval(() => {
    const currentIP = getTailscaleIP();
    if (currentIP && currentIP !== lastTSIP) {
      lastTSIP = currentIP;
      log(`Tailscale IP changed: ${currentIP}. Regenerate QR with 'openanywhere url'.`);
    }
  }, 60_000);

  // OpenCode update detection: restart if binary changed
  let ocBinaryPath = "";
  try { ocBinaryPath = execSync("which opencode", { encoding: "utf-8" }).trim(); } catch {}
  let ocBinaryMtime = 0;
  if (ocBinaryPath) {
    try { ocBinaryMtime = fs.statSync(ocBinaryPath).mtimeMs; } catch {}
  }
  const updateCheckInterval = setInterval(() => {
    if (!ocBinaryPath) return;
    try {
      const newMtime = fs.statSync(ocBinaryPath).mtimeMs;
      if (newMtime > ocBinaryMtime) {
        ocBinaryMtime = newMtime;
        log("OpenCode binary updated. Restarting server...");
        child.kill("SIGTERM");
        // The exit handler above will restart it
      }
    } catch {}
  }, 300_000); // Check every 5 minutes

  // Graceful shutdown
  const cleanup = () => {
    log("Shutting down daemon...");
    clearInterval(netCheckInterval);
    clearInterval(updateCheckInterval);
    child.kill("SIGTERM");
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(PORT_FILE); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  log("Daemon running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
