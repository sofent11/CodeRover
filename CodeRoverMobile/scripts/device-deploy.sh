#!/usr/bin/env bash
set -euo pipefail

# FILE: device-deploy.sh
# Purpose: Builds, installs, and launches the CodeRover iOS app on a connected physical device.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$IOS_ROOT/.." && pwd)"

PROJECT_PATH="$IOS_ROOT/CodeRoverMobile.xcodeproj"
SCHEME="${SCHEME:-CodeRoverMobile}"
CONFIGURATION="${CONFIGURATION:-Debug}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$REPO_ROOT/.derived/CodeRoverMobile-Device}"
BUNDLE_ID="${BUNDLE_ID:-com.sofent.CodeRover}"
ALLOW_PROVISIONING_UPDATES="${ALLOW_PROVISIONING_UPDATES:-1}"
DEVICE_ID="${DEVICE_ID:-}"
DEVICE_NAME="${DEVICE_NAME:-}"
APP_PATH_OVERRIDE="${APP_PATH_OVERRIDE:-}"

usage() {
  cat <<'EOF'
Usage:
  device-deploy.sh build [options]
  device-deploy.sh install [options]
  device-deploy.sh launch [options]
  device-deploy.sh deploy [options]

Commands:
  build     Run xcodebuild for a physical device destination.
  install   Install the built .app onto a connected device.
  launch    Launch the installed app on a connected device.
  deploy    Build, install, then launch.

Options:
  --device-id <id>          Explicit CoreDevice identifier or UDID.
  --device-name <name>      Match a connected device by name.
  --configuration <name>    Xcode build configuration. Default: Debug
  --scheme <name>           Xcode scheme. Default: CodeRoverMobile
  --project <path>          Xcode project path.
  --derived-data <path>     DerivedData path. Default: repo/.derived/CodeRoverMobile-Device
  --bundle-id <id>          App bundle id. Default: com.sofent.CodeRover
  --app-path <path>         Override built .app path for install.
  --no-launch               For deploy, skip app launch after install.
  --console                 For launch, attach app stdout/stderr to this terminal.
  --no-provisioning-updates Do not pass -allowProvisioningUpdates to xcodebuild.
  -h, --help                Show this help.

Examples:
  ./CodeRoverMobile/scripts/device-deploy.sh deploy
  ./CodeRoverMobile/scripts/device-deploy.sh build --device-name iPhone13PM
  ./CodeRoverMobile/scripts/device-deploy.sh install --device-id 60558443-F85C-5848-88D4-C0C912D44A11
EOF
}

json_file="$(mktemp)"
cleanup() {
  rm -f "$json_file"
}
trap cleanup EXIT

resolve_device_id() {
  if [[ -n "$DEVICE_ID" ]]; then
    printf '%s\n' "$DEVICE_ID"
    return
  fi

  xcrun devicectl list devices --json-output "$json_file" >/dev/null

  python3 - "$json_file" "$DEVICE_NAME" <<'PY'
import json
import sys

json_path, requested_name = sys.argv[1], sys.argv[2].strip()

with open(json_path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

devices = payload.get("result", {}).get("devices", [])
connected = []
for device in devices:
    connection = device.get("connectionProperties", {})
    pairing_state = connection.get("pairingState")
    tunnel_state = connection.get("tunnelState")
    if pairing_state != "paired":
        continue
    if tunnel_state not in (None, "", "connected"):
        continue
    identifier = device.get("identifier")
    name = device.get("deviceProperties", {}).get("name") or device.get("hardwareProperties", {}).get("marketingName")
    if not identifier:
        continue
    connected.append((identifier, name or ""))

if requested_name:
    for identifier, name in connected:
        if name == requested_name:
            print(identifier)
            sys.exit(0)
    print(f"No connected device matched name: {requested_name}", file=sys.stderr)
    sys.exit(1)

if not connected:
    print("No connected iOS devices found.", file=sys.stderr)
    sys.exit(1)

print(connected[0][0])
PY
}

resolved_device_id=""
resolve_app_path() {
  if [[ -n "$APP_PATH_OVERRIDE" ]]; then
    printf '%s\n' "$APP_PATH_OVERRIDE"
    return
  fi

  printf '%s\n' "$DERIVED_DATA_PATH/Build/Products/$CONFIGURATION-iphoneos/CodeRoverMobile.app"
}

run_build() {
  resolved_device_id="$(resolve_device_id)"
  local -a cmd=(
    xcodebuild
    -project "$PROJECT_PATH"
    -scheme "$SCHEME"
    -configuration "$CONFIGURATION"
    -destination "id=$resolved_device_id"
    -derivedDataPath "$DERIVED_DATA_PATH"
  )

  if [[ "$ALLOW_PROVISIONING_UPDATES" == "1" ]]; then
    cmd+=(-allowProvisioningUpdates)
  fi

  cmd+=(build)

  echo "[device-deploy] Building scheme=$SCHEME configuration=$CONFIGURATION device=$resolved_device_id"
  "${cmd[@]}"
}

run_install() {
  resolved_device_id="${resolved_device_id:-$(resolve_device_id)}"
  local app_path
  app_path="$(resolve_app_path)"

  if [[ ! -d "$app_path" ]]; then
    echo "[device-deploy] App bundle not found: $app_path" >&2
    exit 1
  fi

  echo "[device-deploy] Installing $app_path to device=$resolved_device_id"
  xcrun devicectl device install app --device "$resolved_device_id" "$app_path"
}

run_launch() {
  resolved_device_id="${resolved_device_id:-$(resolve_device_id)}"

  echo "[device-deploy] Launching $BUNDLE_ID on device=$resolved_device_id"
  if [[ "${LAUNCH_WITH_CONSOLE:-0}" == "1" ]]; then
    xcrun devicectl device process launch --device "$resolved_device_id" --terminate-existing --console "$BUNDLE_ID"
  else
    xcrun devicectl device process launch --device "$resolved_device_id" --terminate-existing "$BUNDLE_ID"
  fi
}

command="${1:-}"
if [[ -z "$command" || "$command" == "-h" || "$command" == "--help" ]]; then
  usage
  exit 0
fi
shift

NO_LAUNCH=0
LAUNCH_WITH_CONSOLE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device-id)
      DEVICE_ID="${2:-}"
      shift 2
      ;;
    --device-name)
      DEVICE_NAME="${2:-}"
      shift 2
      ;;
    --configuration)
      CONFIGURATION="${2:-}"
      shift 2
      ;;
    --scheme)
      SCHEME="${2:-}"
      shift 2
      ;;
    --project)
      PROJECT_PATH="${2:-}"
      shift 2
      ;;
    --derived-data)
      DERIVED_DATA_PATH="${2:-}"
      shift 2
      ;;
    --bundle-id)
      BUNDLE_ID="${2:-}"
      shift 2
      ;;
    --app-path)
      APP_PATH_OVERRIDE="${2:-}"
      shift 2
      ;;
    --no-launch)
      NO_LAUNCH=1
      shift
      ;;
    --console)
      LAUNCH_WITH_CONSOLE=1
      shift
      ;;
    --no-provisioning-updates)
      ALLOW_PROVISIONING_UPDATES=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "$command" in
  build)
    run_build
    ;;
  install)
    run_install
    ;;
  launch)
    run_launch
    ;;
  deploy)
    run_build
    run_install
    if [[ "$NO_LAUNCH" != "1" ]]; then
      run_launch
    fi
    ;;
  *)
    echo "Unknown command: $command" >&2
    usage
    exit 1
    ;;
esac
