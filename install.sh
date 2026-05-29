#!/usr/bin/env bash
set -euo pipefail

# ─── OpenCode Remote Installer ───────────────────────────────────────────────
# One-command setup: curl openanywhere.dev/install.sh | bash
# Gets you from zero → OpenCode on your phone in ~2 minutes.
# ──────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

banner() {
  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║       ${BOLD}OpenCode Remote Installer${NC}${BLUE}          ║${NC}"
  echo -e "${BLUE}║     OpenCode from anywhere, in minutes   ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
  echo ""
}

info()    { echo -e "  ${BLUE}→${NC} $1"; }
success() { echo -e "  ${GREEN}✓${NC} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $1"; }
error()   { echo -e "  ${RED}✗${NC} $1"; }

die() {
  error "$1"
  echo ""
  echo -e "  ${YELLOW}If this persists, please open an issue:${NC}"
  echo -e "  https://github.com/drewsephski/openanywhere/issues"
  exit 1
}

# ─── Prerequisite checks ─────────────────────────────────────────────────────

check_os() {
  if [[ "$OSTYPE" != "darwin"* ]]; then
    warn "Currently only macOS is fully supported."
    warn "Linux support is experimental — YMMV."
  fi
  success "OS: $(sw_vers -productName 2>/dev/null || uname -s) $(sw_vers -productVersion 2>/dev/null || uname -r)"
}

check_internet() {
  if ! curl -s --connect-timeout 5 https://api.github.com > /dev/null 2>&1; then
    die "No internet connection detected."
  fi
  success "Internet: connected"
}

# ─── Dependency installation ─────────────────────────────────────────────────

ensure_homebrew() {
  if command -v brew &> /dev/null; then
    success "Homebrew: found ($(brew --version | head -1))"
    return 0
  fi
  info "Installing Homebrew..."
  if ! /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
    die "Failed to install Homebrew."
  fi
  # Add to PATH for this session
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  success "Homebrew: installed"
}

ensure_bun() {
  if command -v bun &> /dev/null; then
    success "Bun: found ($(bun --version))"
    return 0
  fi
  info "Installing Bun..."
  if ! curl -fsSL https://bun.sh/install | bash; then
    die "Failed to install Bun."
  fi
  # Add to PATH for this session
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun &> /dev/null; then
    # Source profile if needed
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  success "Bun: installed ($(bun --version))"
}

ensure_opencode() {
  if command -v opencode &> /dev/null; then
    success "OpenCode: found ($(opencode --version 2>&1 || echo 'unknown'))"
    return 0
  fi
  info "Installing OpenCode..."
  # OpenCode's installer needs Bun — install it temporarily
  if ! command -v bun &> /dev/null; then
    ensure_bun
  fi
  if ! curl -fsSL https://opencode.ai/install.sh | bash; then
    die "Failed to install OpenCode."
  fi
  # Ensure it's in PATH
  export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
  if ! command -v opencode &> /dev/null; then
    die "OpenCode installed but not found in PATH. Please restart your terminal."
  fi
  success "OpenCode: installed"
}

ensure_tailscale() {
  if command -v tailscale &> /dev/null; then
    success "Tailscale: found ($(tailscale version 2>&1 | head -1))"
    return 0
  fi
  info "Installing Tailscale..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: use the app store or direct download
    warn "Tailscale not found. Please install it manually:"
    echo ""
    echo -e "    ${BOLD}brew install --cask tailscale${NC}"
    echo ""
    echo -e "  Or download from: ${BLUE}https://tailscale.com/download${NC}"
    echo ""
    read -p "  Press enter after installing Tailscale... "
    if ! command -v tailscale &> /dev/null; then
      die "Tailscale still not found after manual install."
    fi
  else
    curl -fsSL https://tailscale.com/install.sh | sh || die "Failed to install Tailscale."
  fi
  success "Tailscale: installed"
}

# ─── Tailscale authentication ────────────────────────────────────────────────

ensure_tailscale_auth() {
  local status
  status=$(tailscale status --json 2>/dev/null || echo '{"BackendState":"NeedsLogin"}')
  local backend
  backend=$(echo "$status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('BackendState','Unknown'))" 2>/dev/null || echo "Unknown")

  if [[ "$backend" == "Running" ]]; then
    local ip
    ip=$(tailscale ip -4 2>/dev/null || echo "unknown")
    success "Tailscale: authenticated (IP: $ip)"
    return 0
  fi

  info "Authenticating Tailscale..."
  echo ""
  echo -e "  ${YELLOW}A browser window will open. Log in to Tailscale to continue.${NC}"
  echo ""

  if ! tailscale up --accept-routes 2>&1; then
    die "Tailscale authentication failed."
  fi

  # Wait for auth to complete
  local waited=0
  while [[ $waited -lt 60 ]]; do
    status=$(tailscale status --json 2>/dev/null || echo '{}')
    backend=$(echo "$status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('BackendState','Unknown'))" 2>/dev/null || echo "Unknown")
    if [[ "$backend" == "Running" ]]; then
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  if [[ "$backend" != "Running" ]]; then
    die "Tailscale authentication timed out. Please run 'tailscale up' manually."
  fi

  local ip
  ip=$(tailscale ip -4 2>/dev/null || echo "unknown")
  success "Tailscale: authenticated (IP: $ip)"
}

# ─── Install companion daemon ────────────────────────────────────────────────

install_companion() {
  info "Installing OpenCode Remote companion..."

  mkdir -p "$HOME/.local/share/openanywhere"
  local INSTALL_DIR="$HOME/.openanywhere"
  mkdir -p "$INSTALL_DIR"

  # If running from a local build, copy the binary
  local SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$SCRIPT_DIR/openanywhere" ]] && file "$SCRIPT_DIR/openanywhere" 2>/dev/null | grep -q "executable"; then
    info "Using local binary..."
    cp "$SCRIPT_DIR/openanywhere" "$INSTALL_DIR/openanywhere"
    chmod +x "$INSTALL_DIR/openanywhere"
  elif [[ -f "$SCRIPT_DIR/../openanywhere" ]] && file "$SCRIPT_DIR/../openanywhere" 2>/dev/null | grep -q "executable"; then
    info "Using local binary..."
    cp "$SCRIPT_DIR/../openanywhere" "$INSTALL_DIR/openanywhere"
    chmod +x "$INSTALL_DIR/openanywhere"
  else
    # Download binary from GitHub Releases
    info "Downloading companion binary..."
    local ARCH
    ARCH=$(uname -m)
    local OS
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    local BINARY_URL="https://github.com/drewsephski/openanywhere/releases/latest/download/openanywhere-${OS}-${ARCH}"
    if ! curl -fsSL --progress-bar "$BINARY_URL" -o "$INSTALL_DIR/openanywhere"; then
      warn "Could not download binary. Trying fallback URL..."
      local FALLBACK_URL="https://github.com/drewsephski/openanywhere/releases/latest/download/openanywhere"
      if ! curl -fsSL --progress-bar "$FALLBACK_URL" -o "$INSTALL_DIR/openanywhere"; then
        die "Failed to download companion binary. Check your internet connection."
      fi
    fi
    chmod +x "$INSTALL_DIR/openanywhere"
  fi

  # Create launcher script (thin wrapper for PATH convenience)
  cat > "$INSTALL_DIR/openanywhere.sh" << 'LAUNCHER_EOF'
#!/usr/bin/env bash
exec "$HOME/.openanywhere/openanywhere" "$@"
LAUNCHER_EOF
  chmod +x "$INSTALL_DIR/openanywhere.sh"

  # Add to PATH (link the binary name for convenience)
  ln -sf "$INSTALL_DIR/openanywhere" "$INSTALL_DIR/openanywhere-bin" 2>/dev/null || true

  # Add to PATH
  local SHELL_RC=""
  if [[ -f "$HOME/.zshrc" ]]; then SHELL_RC="$HOME/.zshrc"; fi
  if [[ -f "$HOME/.bashrc" ]]; then SHELL_RC="$HOME/.bashrc"; fi

  if [[ -n "$SHELL_RC" ]] && ! grep -q "openanywhere" "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# OpenCode Remote" >> "$SHELL_RC"
    echo 'export PATH="$HOME/.openanywhere:$PATH"' >> "$SHELL_RC"
  fi

  export PATH="$HOME/.openanywhere:$PATH"
  success "Companion: installed"
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  banner

  echo -e "  ${BOLD}Checking system...${NC}"
  echo ""
  check_os
  check_internet

  echo ""
  echo -e "  ${BOLD}Installing dependencies...${NC}"
  echo ""
  ensure_homebrew
  ensure_tailscale
  ensure_opencode

  echo ""
  echo -e "  ${BOLD}Setting up remote access...${NC}"
  echo ""
  ensure_tailscale_auth
  install_companion

  echo ""
  echo -e "  ${GREEN}${BOLD}✓ Installation complete!${NC}"
  echo ""
  echo -e "  ${BOLD}To start OpenCode Remote:${NC}"
  echo ""
  echo -e "    ${BLUE}openanywhere${NC}"
  echo ""
  echo -e "  This will start OpenCode and display a QR code."
  echo -e "  Scan it with your phone to access OpenCode from anywhere."
  echo ""
  echo -e "  ${BOLD}To auto-start on boot:${NC}"
  echo ""
  echo -e "    ${BLUE}openanywhere install-boot${NC}"
  echo ""

  # Ask if user wants to start now
  read -p "  Start OpenCode Remote now? [Y/n] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]?$|^$ ]]; then
    echo ""
    exec "$HOME/.openanywhere/openanywhere"
  fi
}

main "$@"
