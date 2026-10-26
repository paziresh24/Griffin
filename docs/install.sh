#!/usr/bin/env bash
# Griffin: install or update on a Linux server with one command.
#
#   curl -fsSL https://griffin.paziresh24.com/install.sh | bash
#
# It checks the machine, installs Docker if it is missing, pulls the Griffin image, starts it and
# waits until it answers. Running the same command again is the update: the new version starts next
# to your data (the griffin-data and griffin-workspace Docker volumes are never touched), and if it
# does not come up healthy the previous one is put straight back.
#
# Optional settings (put them before `bash`, e.g. `curl … | GRIFFIN_PORT=3200 bash`):
#   GRIFFIN_PORT     port on this machine (default 3100)
#   GRIFFIN_BIND     address to listen on (default: 0.0.0.0 on a private network, 127.0.0.1 when the
#                    machine has a public IP — then open it through an SSH tunnel or a reverse proxy)
#   GRIFFIN_PROXY    outgoing HTTP proxy (http://host:port) for Docker's download, the image pull and
#                    Griffin itself — for blocked regions or a firewall
#   GRIFFIN_PUBLIC_URL  the https address people will use, if you put Griffin behind one
#   GRIFFIN_IMAGE    image to run (default ghcr.io/paziresh24/griffin:latest)
#   GRIFFIN_NAME     container name (default griffin)
#   GRIFFIN_FORCE=1  update even while a chat is running (it is marked failed)
#   ANTHROPIC_API_KEY / OPENAI_API_KEY (+ GRIFFIN_OPENAI_BASE_URL) / CURSOR_API_KEY
#                    an engine key up front; otherwise the setup wizard asks for one in the browser
#
# Settings are remembered in /etc/griffin/ for the next run (keys only in griffin.env, mode 600)
# once the install or update succeeded.

# Everything is inside main(), so a download cut halfway runs nothing.
main() {
  set -Eeuo pipefail

  local ETC=/etc/griffin
  local IMAGE NAME PORT BIND PROXY PUBLIC_URL FORCE
  local SUDO="" NET_ARGS=() BUILT=0

  say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
  info() { printf '    %s\n' "$*"; }
  warn() { printf '\033[33m!!\033[0m  %s\n' "$*" >&2; }
  die()  { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
  have() { command -v "$1" >/dev/null 2>&1; }
  # sudo drops the environment; the proxy has to reach apt, curl and the Docker installer.
  as_root() { if [ -n "$SUDO" ]; then sudo --preserve-env=http_proxy,https_proxy,HTTP_PROXY,HTTPS_PROXY,no_proxy,NO_PROXY "$@"; else "$@"; fi; }

  # --- the machine ---------------------------------------------------------------------------
  [ "$(uname -s)" = Linux ] || die "this installer is for Linux servers. On macOS or Windows install Docker Desktop and run:
  docker run -d --name griffin --restart unless-stopped -p 3100:3100 -v griffin-data:/data -v griffin-workspace:/workspace ghcr.io/paziresh24/griffin:latest"

  if [ "$(id -u)" -ne 0 ]; then
    have sudo || die "run this as root, or install sudo first."
    SUDO=sudo
    say "Some steps need root; sudo may ask for your password."
    { sudo -v </dev/tty; } 2>/dev/null || sudo -n true 2>/dev/null || die "sudo did not work for this user."
  fi

  # Remembered settings first, then the environment wins.
  if as_root test -f "$ETC/install.conf"; then
    local line key value
    while IFS= read -r line; do
      key=${line%%=*}; value=${line#*=}
      case "$key" in
        PORT) PORT=$value ;; BIND) BIND=$value ;; PROXY) PROXY=$value ;;
        PUBLIC_URL) PUBLIC_URL=$value ;; IMAGE) IMAGE=$value ;; NAME) NAME=$value ;;
      esac
    done < <(as_root cat "$ETC/install.conf")
  fi
  IMAGE=${GRIFFIN_IMAGE:-${IMAGE:-ghcr.io/paziresh24/griffin:latest}}
  NAME=${GRIFFIN_NAME:-${NAME:-griffin}}
  PORT=${GRIFFIN_PORT:-${PORT:-3100}}
  PROXY=${GRIFFIN_PROXY:-${PROXY:-}}
  PUBLIC_URL=${GRIFFIN_PUBLIC_URL:-${PUBLIC_URL:-}}
  FORCE=${GRIFFIN_FORCE:-0}
  case "$PORT" in ''|*[!0-9]*) die "GRIFFIN_PORT must be a number." ;; esac

  if [ -n "$PROXY" ]; then
    export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
    export no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1"
    say "Using the outgoing proxy ${PROXY/\/\/*@/\/\/***@}"
  fi

  local arch; arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) ;;
    aarch64|arm64) warn "the published image is for x86_64; on $arch Griffin is built from source (a few minutes)." ;;
    *) die "unsupported CPU architecture: $arch" ;;
  esac

  local free_kb; free_kb=$(df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}' || true)
  if [ -n "$free_kb" ] && [ "$free_kb" -lt 3000000 ]; then
    die "less than 3 GB free on /var/lib (Docker's images and Griffin's data live there). Free some space and run again."
  fi
  local mem_kb; mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  [ "${mem_kb:-0}" -ge 900000 ] || warn "less than 1 GB of RAM; Griffin may be slow or be killed under load."

  # --- Docker --------------------------------------------------------------------------------
  install_docker() {
    say "Installing Docker"
    # The official script first; it is refused from some regions (403), so the distribution's own
    # package is the fallback.
    if curl -fsSL --max-time 60 https://get.docker.com -o /tmp/get-docker.sh 2>/dev/null \
      && as_root sh /tmp/get-docker.sh >/tmp/griffin-docker-install.log 2>&1; then
      rm -f /tmp/get-docker.sh
      return 0
    fi
    rm -f /tmp/get-docker.sh
    warn "the official Docker installer did not work (see /tmp/griffin-docker-install.log); trying this system's package."
    if have apt-get; then
      # The official script may have added its apt source before being refused; it would break apt.
      as_root rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources
      as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq || warn "apt-get update reported errors; trying anyway."
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io ca-certificates curl
    elif have dnf; then
      as_root dnf install -y -q moby-engine 2>/dev/null || as_root dnf install -y -q docker
    elif have yum; then
      as_root yum install -y -q docker
    elif have zypper; then
      as_root zypper --non-interactive install docker
    elif have pacman; then
      as_root pacman -Sy --noconfirm docker
    elif have apk; then
      as_root apk add --no-cache docker
    else
      die "no package manager found to install Docker. Install Docker yourself (https://docs.docker.com/engine/install/) and run this again."
    fi
  }

  start_docker() {
    if have systemctl && [ -d /run/systemd/system ]; then
      as_root systemctl enable --now docker >/dev/null 2>&1 || as_root systemctl start docker
    elif have rc-service; then
      as_root rc-update add docker default >/dev/null 2>&1 || true
      as_root rc-service docker start
    elif have service; then
      as_root service docker start
    else
      die "Docker is installed but could not be started (no systemd/OpenRC/service). Start dockerd and run this again."
    fi
  }

  if ! have docker; then
    install_docker
    have docker || die "Docker did not install. The log is in /tmp/griffin-docker-install.log."
  fi
  if ! as_root docker info >/dev/null 2>&1; then
    say "Starting Docker"
    start_docker
    local i
    for i in $(seq 1 30); do as_root docker info >/dev/null 2>&1 && break; sleep 1; done
    as_root docker info >/dev/null 2>&1 || die "Docker is installed but not running. Check: sudo systemctl status docker"
  fi
  info "Docker $(as_root docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') is running"

  # --- where it listens ----------------------------------------------------------------------
  local public_ip=""
  if have ip; then
    public_ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' \
      | grep -Ev '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' | head -1 || true)
  fi
  if [ -z "${GRIFFIN_BIND:-}" ] && [ -z "${BIND:-}" ]; then
    if [ -n "$public_ip" ]; then BIND=127.0.0.1; else BIND=0.0.0.0; fi
  fi
  BIND=${GRIFFIN_BIND:-$BIND}

  # A proxy on this machine's loopback is reachable from the container only on the host network.
  case "$PROXY" in
    *://127.*|*://localhost*|*://\[::1\]*) NET_ARGS=(--network host -e "HOST=$BIND" -e "PORT=$PORT") ;;
    *) NET_ARGS=(-p "$BIND:$PORT:3100" --add-host=host.docker.internal:host-gateway) ;;
  esac

  local exists=0 running=0
  if as_root docker container inspect "$NAME" >/dev/null 2>&1; then
    exists=1
    if [ "$(as_root docker container inspect -f '{{.State.Running}}' "$NAME")" = true ]; then running=1; fi
  fi
  if [ "$exists" = 0 ] && have ss && ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
    die "port $PORT is already in use on this machine. Pick another: curl -fsSL https://griffin.paziresh24.com/install.sh | GRIFFIN_PORT=3200 bash"
  fi

  # --- the container's settings --------------------------------------------------------------
  as_root mkdir -p "$ETC"
  as_root chmod 700 "$ETC"
  # The container's environment: the proxy and URL, plus any engine key given now (kept from before
  # otherwise). Mode 600, root only.
  local envfile="$ETC/griffin.env" tmp
  tmp=$(mktemp)
  chmod 600 "$tmp"
  if as_root test -f "$envfile"; then
    as_root cat "$envfile" | grep -Ev '^(GRIFFIN_PROXY|GRIFFIN_PUBLIC_URL)=' >"$tmp" || true
  fi
  if [ -n "$PROXY" ]; then printf 'GRIFFIN_PROXY=%s\n' "$PROXY" >>"$tmp"; fi
  if [ -n "$PUBLIC_URL" ]; then printf 'GRIFFIN_PUBLIC_URL=%s\n' "$PUBLIC_URL" >>"$tmp"; fi
  local var
  for var in ANTHROPIC_API_KEY OPENAI_API_KEY GRIFFIN_OPENAI_BASE_URL CURSOR_API_KEY GRIFFIN_DEMO; do
    if [ -n "${!var:-}" ]; then
      grep -v "^$var=" "$tmp" >"$tmp.2" || true
      mv -f "$tmp.2" "$tmp"
      printf '%s=%s\n' "$var" "${!var}" >>"$tmp"
    fi
  done
  as_root install -m 600 -o root -g root "$tmp" "$envfile"
  rm -f "$tmp" "$tmp.2"

  # --- the image -----------------------------------------------------------------------------
  docker_proxy() { # Docker pulls through the daemon, which does not see this shell's proxy.
    have systemctl && [ -d /run/systemd/system ] || return 1
    say "Pointing Docker's downloads at $PROXY (this restarts Docker; containers with a restart policy come back)"
    as_root mkdir -p /etc/systemd/system/docker.service.d
    printf '[Service]\nEnvironment="HTTP_PROXY=%s" "HTTPS_PROXY=%s" "NO_PROXY=localhost,127.0.0.1,::1"\n' "$PROXY" "$PROXY" \
      | as_root tee /etc/systemd/system/docker.service.d/griffin-proxy.conf >/dev/null
    as_root systemctl daemon-reload
    as_root systemctl restart docker
    local i
    for i in $(seq 1 30); do as_root docker info >/dev/null 2>&1 && return 0; sleep 1; done
    return 1
  }
  pull() {
    local i
    for i in 1 2 3; do
      as_root docker pull -q "$IMAGE" >/dev/null 2>&1 && return 0
      sleep $((i * 3))
    done
    return 1
  }

  local old_id=""
  if [ "$exists" = 1 ]; then old_id=$(as_root docker container inspect -f '{{.Image}}' "$NAME"); fi
  case "$arch" in
    aarch64|arm64)
      if [ -z "${GRIFFIN_IMAGE:-}" ]; then
        say "Building Griffin from source (github.com/paziresh24/Griffin)"
        IMAGE=griffin-app:local
        as_root docker build -q --target app -t "$IMAGE" https://github.com/paziresh24/Griffin.git#main >/dev/null \
          || die "the build did not finish. If GitHub or npm is blocked here, set GRIFFIN_PROXY and run again."
        BUILT=1
      fi
      ;;
  esac
  if [ "$BUILT" = 0 ]; then
    say "Downloading $IMAGE"
    if ! pull; then
      if [ -n "$PROXY" ] && docker_proxy && pull; then :
      elif [ -n "$PROXY" ]; then
        die "the image could not be downloaded, even through $PROXY. Check that the proxy works: curl -x $PROXY -I https://ghcr.io"
      else
        die "the image could not be downloaded from ghcr.io. If this server is behind a firewall or in a blocked region, run again with a proxy:
  curl -fsSL https://griffin.paziresh24.com/install.sh | GRIFFIN_PROXY=http://<proxy-host>:<port> bash"
      fi
    fi
  fi
  local new_id; new_id=$(as_root docker image inspect -f '{{.Id}}' "$IMAGE")

  local check_host=127.0.0.1
  case "$BIND" in 0.0.0.0|127.0.0.1) ;; *) check_host=$BIND ;; esac
  healthz() { curl -fsS --noproxy '*' --max-time 3 "http://$check_host:$PORT/healthz" 2>/dev/null; }
  wait_healthy() {
    local i
    for i in $(seq 1 90); do
      healthz | grep -q '"ok":true' && return 0
      [ "$(as_root docker container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || return 1
      sleep 2
    done
    return 1
  }
  run_container() {
    as_root docker run -d --name "$NAME" --restart unless-stopped \
      "${NET_ARGS[@]}" --env-file "$envfile" \
      -v griffin-data:/data -v griffin-workspace:/workspace \
      --log-opt max-size=20m --log-opt max-file=3 \
      "$IMAGE" >/dev/null
  }

  # --- start or update -----------------------------------------------------------------------
  if [ "$exists" = 1 ] && [ "$running" = 1 ] && [ "$old_id" = "$new_id" ] && healthz >/dev/null; then
    say "Griffin is already the latest version and running"
  elif [ "$exists" = 1 ]; then
    if [ "$running" = 1 ] && [ "$FORCE" != 1 ]; then
      local i active
      for i in $(seq 1 60); do
        active=$(healthz | sed -n 's/.*"activeRuns":\([0-9]*\).*/\1/p' || true)
        [ "${active:-0}" = 0 ] && break
        [ "$i" = 1 ] && say "A chat is running; waiting for it to finish before the update (up to 10 minutes; GRIFFIN_FORCE=1 skips this)"
        sleep 10
      done
      [ "${active:-0}" = 0 ] || die "chats are still running after 10 minutes. Run again later, or with GRIFFIN_FORCE=1."
    fi
    say "Updating Griffin"
    as_root docker rm -f "$NAME-previous" >/dev/null 2>&1 || true
    as_root docker stop -t 30 "$NAME" >/dev/null 2>&1 || true
    as_root docker rename "$NAME" "$NAME-previous"
    if run_container && wait_healthy; then
      as_root docker rm -f "$NAME-previous" >/dev/null
    else
      warn "the new version did not come up healthy; putting the previous one back. Its log:"
      as_root docker logs --tail 30 "$NAME" 2>&1 | sed 's/^/    /' >&2 || true
      as_root docker rm -f "$NAME" >/dev/null 2>&1 || true
      as_root docker rename "$NAME-previous" "$NAME"
      as_root docker start "$NAME" >/dev/null
      die "the update was rolled back; Griffin runs the previous version."
    fi
  else
    say "Starting Griffin"
    run_container || die "the container did not start. See: sudo docker logs $NAME"
    wait_healthy || { as_root docker logs --tail 40 "$NAME" 2>&1 | sed 's/^/    /' >&2; die "Griffin started but does not answer on port $PORT. The log is above."; }
  fi
  # Remembered for the next run only once this version is up: a rolled-back image is not kept.
  printf 'PORT=%s\nBIND=%s\nPROXY=%s\nPUBLIC_URL=%s\nIMAGE=%s\nNAME=%s\n' \
    "$PORT" "$BIND" "$PROXY" "$PUBLIC_URL" "$IMAGE" "$NAME" | as_root tee "$ETC/install.conf" >/dev/null
  # Old images of this tag are not needed any more.
  as_root docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/paziresh24/Griffin" >/dev/null 2>&1 || true

  # --- how to open it ------------------------------------------------------------------------
  local version; version=$(healthz | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' || true)
  local lan_ip=""
  if have ip; then lan_ip=$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true); fi
  local docker_cmd="docker"; if [ -n "$SUDO" ]; then docker_cmd="sudo docker"; fi
  echo
  say "Griffin is up${version:+ (version $version)}"
  echo
  if [ -n "$PUBLIC_URL" ]; then
    info "Open:   $PUBLIC_URL"
  elif [ "$BIND" = 127.0.0.1 ]; then
    info "Griffin listens only on this machine (it has a public IP). From your laptop:"
    info "        ssh -L $PORT:127.0.0.1:$PORT $(id -un)@${public_ip:-<this-server>}"
    info "        then open http://127.0.0.1:$PORT"
    info "        (or put it behind HTTPS and run again with GRIFFIN_PUBLIC_URL=https://…)"
  else
    info "Open:   http://${lan_ip:-<this-server>}:$PORT"
  fi
  info "Log in with the token printed by:   $docker_cmd exec $NAME cat /data/owner.token"
  info "        (keep it private; after the first login turn on two-step sign-in in Settings → Account)"
  echo
  info "Update: run the same install command again"
  info "Logs:   $docker_cmd logs -f $NAME"
  info "Stop:   $docker_cmd stop $NAME      (your data stays in the griffin-data and griffin-workspace volumes)"
}

main "$@"
