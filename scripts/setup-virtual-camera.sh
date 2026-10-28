#!/usr/bin/env bash
#
# Gives viicell-face its own v4l2loopback device.
#
# The app streams into any existing v4l2loopback device, so this script is
# optional. It is worth running when you want a stable camera name in pickers
# ("viicell-face" instead of whatever the first loopback device is called) and
# when another virtual camera (OBS, camera-upright, ...) already owns one.
#
# Usage:
#   sudo scripts/setup-virtual-camera.sh
#   sudo DEVICE_NR=12 LABEL=viicell-face scripts/setup-virtual-camera.sh
#
# Re-running is safe: it keeps the devices the current configuration declares
# and only adds one more.

set -euo pipefail

DEVICE_NR="${DEVICE_NR:-11}"
LABEL="${LABEL:-viicell-face}"
CONF="/etc/modprobe.d/zz-viicell-face.conf"

if [[ ${EUID} -ne 0 ]]; then
    echo "error: run with sudo: sudo $0" >&2
    exit 1
fi
for tool in modprobe python3; do
    command -v "$tool" >/dev/null || {
        echo "error: $tool is required" >&2
        exit 1
    }
done

if grep -qsx -- "$LABEL" /sys/class/video4linux/*/name 2>/dev/null; then
    echo "nothing to do: a loopback device labelled \"$LABEL\" already exists"
    exit 0
fi

# kmod uses the last matching `options` line, so the file we write is merged
# from whatever is in effect today.
current_options="$(
    grep -hsE '^[[:space:]]*options[[:space:]]+v4l2loopback([[:space:]]|$)' \
        /etc/modprobe.d/*.conf 2>/dev/null | tail -n 1 || true
)"

merged="$(
    python3 - "$current_options" "$DEVICE_NR" "$LABEL" <<'PY'
import shlex
import sys

current, number, label = sys.argv[1], sys.argv[2], sys.argv[3]
tokens = shlex.split(current)[2:] if current.strip() else []

options = {}
for token in tokens:
    key, _, value = token.partition("=")
    if key:
        options[key] = value

def add(key, value):
    values = [item for item in options.get(key, "").split(",") if item]
    if value not in values:
        values.append(value)
    options[key] = ",".join(values)

add("video_nr", number)
add("card_label", label)
add("exclusive_caps", "1")
# A second device must be allowed to hold at least a 1080p frame.
for key, value in (("max_buffers", "4"), ("max_width", "1920"), ("max_height", "1080")):
    options.setdefault(key, value)

numbers = [item for item in options["video_nr"].split(",") if item]
labels = [item for item in options["card_label"].split(",") if item]
if len(numbers) != len(labels):
    sys.exit(
        "error: the current options declare %d video_nr values but %d card labels;\n"
        "       edit /etc/modprobe.d/*.conf so both lists have one entry per device, then retry."
        % (len(numbers), len(labels))
    )

# exclusive_caps is also a per-device array: without an entry the new device
# would not report itself as a capture device and pickers would ignore it.
caps = [item for item in options.get("exclusive_caps", "").split(",") if item]
if len(caps) < len(numbers):
    options["exclusive_caps"] = ",".join(caps + ["1"] * (len(numbers) - len(caps)))

parts = []
for key, value in options.items():
    if key == "card_label":
        value = ",".join(f'"{item}"' if " " in item else item for item in value.split(","))
    parts.append(f"{key}={value}")

print("options v4l2loopback " + " ".join(parts))
PY
)"

printf '%s\n' \
    "# Managed by viicell-face/scripts/setup-virtual-camera.sh" \
    "$merged" > "$CONF"

echo "wrote $CONF:"
echo "  $merged"

echo "reloading v4l2loopback (any streaming virtual camera is interrupted)…"
if ! modprobe -r v4l2loopback 2>/dev/null; then
    echo "error: could not unload v4l2loopback; close apps using the virtual camera and retry" >&2
    exit 1
fi
modprobe v4l2loopback

for _ in 1 2 3 4 5 6 7 8 9 10; do
    device="$(grep -lsx -- "$LABEL" /sys/class/video4linux/*/name 2>/dev/null || true)"
    if [[ -n $device ]]; then
        echo "done: \"$LABEL\" is available at /dev/$(basename "$(dirname "$device")")"
        exit 0
    fi
    sleep 0.2
done

echo "warning: the module loaded but no \"$LABEL\" device appeared; check $CONF" >&2
exit 1
