#!/bin/bash
set -e

# Configuration (all overridable via environment variables)
PLUGIN_PATTERN="${PLUGIN_PATTERN:-homebridge-*.tgz}"
CONTAINER_PATTERN="${CONTAINER_PATTERN:-homebridge-homebridge-}"

REMOTE_HOST="${REMOTE_HOST:-stansberry.netbird.cloud}"
REMOTE_USER="${REMOTE_USER:-stansberry}"

REMOTE_PLUGIN_DIR="${REMOTE_PLUGIN_DIR:-/home/stansberry/Containerized/homebridge/volumes/homebridge/custom}"
CONTAINER_MOUNT_PATH="${CONTAINER_MOUNT_PATH:-/homebridge/custom}"

# SSH multiplexing - authenticate once, reuse connection
SSH_CONTROL_PATH="/tmp/ssh-deploy-$$"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=$SSH_CONTROL_PATH -o ControlPersist=60"

# Cleanup on exit
cleanup() {
    ssh -O exit -o ControlPath="$SSH_CONTROL_PATH" "$REMOTE_USER@$REMOTE_HOST" 2>/dev/null || true
}
trap cleanup EXIT
# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Find the latest .tgz file by semver (largest version number)
find_latest_tgz() {
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    # Find all .tgz files matching the plugin pattern and sort by version
    local latest=$(ls -1 "$script_dir"/$PLUGIN_PATTERN 2>/dev/null | \
        sed 's/.*-\([0-9]*\.[0-9]*\.[0-9]*\)\.tgz/\1 &/' | \
        sort -t. -k1,1n -k2,2n -k3,3n | \
        tail -1 | \
        awk '{print $2}')
    
    if [[ -z "$latest" ]]; then
        log_error "No .tgz files found in $script_dir"
        exit 1
    fi
    
    echo "$latest"
}

# Find the homebridge container on remote host
find_container() {
    ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "sudo docker ps --format '{{.Names}}' | grep -E '^${CONTAINER_PATTERN}' | head -1"
}

# Main deployment
main() {
    log_info "Starting deployment to $REMOTE_HOST..."
    
    # Step 1: Find the latest .tgz
    local tgz_file=$(find_latest_tgz)
    local tgz_basename=$(basename "$tgz_file")
    log_info "Found package: $tgz_basename"
    
    # Step 2: Copy to remote host
    log_info "Copying to remote host..."
    scp $SSH_OPTS "$tgz_file" "$REMOTE_USER@$REMOTE_HOST:/tmp/$tgz_basename"
    
    # Step 3: Move to plugin directory (requires sudo)
    log_info "Moving to plugin directory..."
    ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "sudo mv /tmp/$tgz_basename $REMOTE_PLUGIN_DIR/"
    
    # Step 4: Find the container name
    log_info "Finding Homebridge container..."
    local container=$(find_container)
    if [[ -z "$container" ]]; then
        log_error "Could not find homebridge container"
        exit 1
    fi
    log_info "Found container: $container"
    
    # Step 5: Install the plugin inside the container
    log_info "Installing plugin in container..."
    ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "sudo docker exec $container npm --prefix /var/lib/homebridge install $CONTAINER_MOUNT_PATH/$tgz_basename"
    
    # Step 6: Restart the container
    log_info "Restarting container..."
    ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "sudo docker restart $container"
    
    log_info "Deployment complete!"
}

# Run if not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
