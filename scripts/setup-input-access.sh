#!/usr/bin/env sh
# Grants the face read access to the keyboard and pointer devices, so its keys
# (Z / X / C, 0 + 1-5, D) work while another window has focus.
#
# Wayland has no global-shortcut API that also carries the scroll wheel, so the
# controls read the raw input devices directly. That needs permission, and the
# narrowest one is the logind "uaccess" tag: only the user with the active
# desktop session gets the ACL, and it goes away when the session ends.
#
# Like any global-hotkey tool, this means the device events are readable by the
# user's processes. Undo with:
#   sudo rm /etc/udev/rules.d/70-viicell-face-input.rules
#   sudo udevadm control --reload-rules
set -eu

RULE=/etc/udev/rules.d/70-viicell-face-input.rules

cat > "$RULE" <<'EOF'
# viicell-face: read the keyboard / pointer of the active session.
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", TAG+="uaccess"
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_MOUSE}=="1", TAG+="uaccess"
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TOUCHPAD}=="1", TAG+="uaccess"
EOF

udevadm control --reload-rules
udevadm trigger --subsystem-match=input --action=change

# Show the grant landed, so a silent no-op (wrong seat, no logind ACL) is
# visible right here instead of puzzling over a `keys window` HUD.
USER_NAME=${SUDO_USER:-$(id -un)}
granted=0
for dev in /dev/input/event*; do
    if getfacl -pc "$dev" 2>/dev/null | grep -qx "user:$USER_NAME:rw-"; then
        granted=$((granted + 1))
    fi
done

if [ "$granted" -eq 0 ]; then
    echo "no input device was granted to $USER_NAME" >&2
    exit 1
fi

echo "done: $granted input device(s) readable by $USER_NAME"
echo "viicell-face picks them up within a few seconds; no restart needed"
