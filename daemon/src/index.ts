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

function printBanner(url: string, password: string): void {
  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║      OpenCode Remote — Ready!            ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");
  console.log(`  📱  Open on your phone:`);
  console.log(`      ${url}`);
  console.log("");
  console.log(`  🔑  Password:  ${password}`);
  console.log("");
  console.log("  ───────────────────────────────────────────");
  console.log("");
}

// ─── QR Code ────────────────────────────────────────────────────────────────

async function printQR(url: string): Promise<void> {
  try {
    const qrcode = await import("qrcode-terminal");
    qrcode.default.generate(url, { small: true }, (q: string) => {
      console.log(q);
    });
  } catch {
    console.log(
      "  [QR code unavailable — install qrcode-terminal for QR display]"
    );
    console.log("  [Use the URL above to access on your phone]");
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
  * { box-sizing:border-box; margin:0; padding:0 }
  body { font-family:-apple-system,BlinkMacSystemFont,sans-serif; background:#1a1a2e; color:#eee; display:flex; align-items:center; justify-content:center; min-height:100vh }
  .card { background:#16213e; border-radius:16px; padding:32px 24px; max-width:360px; width:100%; text-align:center; box-shadow:0 8px 32px rgba(0,0,0,.3) }
  h1 { font-size:20px; margin-bottom:8px }
  p { color:#a0a0b8; font-size:14px; margin-bottom:20px }
  input { width:100%; padding:12px; border-radius:10px; border:1px solid #2a2a4a; background:#0f0f23; color:#fff; font-size:16px; text-align:center; margin-bottom:12px }
  input:focus { outline:none; border-color:#6c63ff }
  button { width:100%; padding:12px; border-radius:10px; border:none; background:#6c63ff; color:#fff; font-size:16px; font-weight:600; cursor:pointer }
  button:active { background:#5a52d5 }
  .error { color:#ff6b6b; font-size:13px; margin-top:8px; display:none }
  .hint { font-size:12px; color:#666; margin-top:16px }
</style>
</head>
<body>
<div class="card">
  <h1>🔐 OpenCode Remote</h1>
  <p>Enter the password shown in your terminal</p>
  <form onsubmit="return submitPassword(event)">
    <input type="password" id="pw" placeholder="Password" autofocus>
    <button type="submit">Connect</button>
    <div class="error" id="err">Invalid password</div>
  </form>
  <p class="hint">Or scan the QR code again for instant access</p>
</div>
<script>
async function submitPassword(e) {
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  const resp = await fetch('/?t=' + encodeURIComponent(pw), { redirect:'manual' });
  if (resp.status === 302) {
    window.location.href = resp.headers.get('Location') || '/';
  } else {
    document.getElementById('err').style.display = 'block';
  }
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

  // Display info using the proxy URL
  const tsIP = getTailscaleIP() || "localhost";
  const token = loadToken();
  const displayUrl = `http://${tsIP}:${proxyPort}/?t=${token}`;

  printBanner(displayUrl, password);
  await printQR(displayUrl);

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
