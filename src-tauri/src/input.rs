//! Global keyboard and wheel input.
//!
//! The face has to be posable while another window has focus. Wayland gives no
//! way to grab a shortcut that also carries the scroll wheel, so the raw input
//! devices are read directly — what every global-hotkey tool on Wayland ends up
//! doing. That needs read access to `/dev/input/event*`, granted once by
//! `scripts/setup-input-access.sh`.
//!
//! Only the handful of keys the rig uses leave this module; everything else is
//! dropped here and never reaches the webview.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::os::raw::c_ulong;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Event name the webview listens to.
const EVENT_NAME: &str = "input";
/// How often `/dev/input` is rescanned, so a replugged keyboard is picked up.
const RESCAN_INTERVAL: Duration = Duration::from_secs(3);

const EV_KEY: u16 = 1;
const EV_REL: u16 = 2;
const REL_WHEEL: u16 = 8;
const REL_WHEEL_HI_RES: u16 = 11;
/// One wheel notch, in high-resolution units.
const HI_RES_NOTCH: i32 = 120;
/// `EVIOCGBIT(0, 8)`: which event types the device can produce.
const EVIOCGBIT_TYPES: c_ulong = 0x8000_0000 | (8 << 16) | (0x45 << 8) | 0x20;

/// One event for the controls.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum InputEvent {
    Key {
        name: &'static str,
        pressed: bool,
    },
    /// `notches` is positive for scrolling up.
    Wheel {
        notches: i32,
    },
}

/// `struct input_event` on 64-bit Linux.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RawEvent {
    tv_sec: i64,
    tv_usec: i64,
    kind: u16,
    code: u16,
    value: i32,
}

/// Reads the input devices and forwards the controls to the webview.
pub struct GlobalInput {
    available: Arc<AtomicBool>,
}

impl GlobalInput {
    pub fn start(app: AppHandle) -> GlobalInput {
        let available = Arc::new(AtomicBool::new(false));
        let open = Arc::new(Mutex::new(HashSet::new()));

        let state = Arc::clone(&available);
        let live = Arc::clone(&open);
        thread::spawn(move || scan(app, state, live));

        GlobalInput { available }
    }

    /// Whether keys are being read from the devices rather than the window.
    pub fn available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }
}

/// Opens every readable input device and keeps looking for new ones.
fn scan(app: AppHandle, available: Arc<AtomicBool>, open: Arc<Mutex<HashSet<PathBuf>>>) {
    loop {
        let entries = fs::read_dir("/dev/input")
            .map(|dir| dir.flatten().map(|entry| entry.path()).collect::<Vec<_>>())
            .unwrap_or_default();

        let mut opened = false;

        for path in entries {
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("event"))
            {
                continue;
            }

            let already_open = open.lock().map(|set| set.contains(&path)).unwrap_or(true);
            if already_open {
                continue;
            }

            let Ok(file) = File::open(&path) else {
                continue;
            };
            if !has_controls(&file) {
                continue;
            }

            if let Ok(mut set) = open.lock() {
                set.insert(path.clone());
            }
            opened = true;

            let app = app.clone();
            let open = Arc::clone(&open);
            thread::spawn(move || {
                read_device(app, file);
                // The device went away or errored: let the scan try it again.
                if let Ok(mut set) = open.lock() {
                    set.remove(&path);
                }
            });
        }

        // Tell the UI the first time a device can be read, so installing the
        // access rule takes effect without restarting the app.
        if opened && !available.swap(true, Ordering::Relaxed) {
            let _ = app.emit("input-ready", ());
        }

        thread::sleep(RESCAN_INTERVAL);
    }
}

/// True for keyboards, mice and touchpads: anything with keys or a wheel.
fn has_controls(file: &File) -> bool {
    let mut types = [0u8; 8];
    // SAFETY: the kernel fills exactly `types.len()` bytes for EVIOCGBIT(0, 8).
    let result = unsafe { libc::ioctl(file.as_raw_fd(), EVIOCGBIT_TYPES, types.as_mut_ptr()) };
    result >= 0 && (types[0] & ((1 << EV_KEY) | (1 << EV_REL))) != 0
}

fn read_device(app: AppHandle, mut file: File) {
    let mut buffer = [0u8; std::mem::size_of::<RawEvent>()];
    let mut wheel = WheelState::default();

    loop {
        if file.read_exact(&mut buffer).is_err() {
            return;
        }

        // SAFETY: the kernel writes one `input_event` per read; all fields are
        // plain integers, so any alignment is valid.
        let event: RawEvent = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast()) };
        if let Some(input) = translate(event, &mut wheel) {
            let _ = app.emit(EVENT_NAME, input);
        }
    }
}

/// Scroll state of one device: wheels report either plain notches or
/// high-resolution deltas, and a few report both.
#[derive(Default)]
struct WheelState {
    /// High-resolution delta accumulated towards a whole notch.
    high_res: i32,
    /// Set once the device has reported a plain notch.
    plain: bool,
}

/// Turns a raw event into a control event, for the few we care about.
fn translate(event: RawEvent, wheel: &mut WheelState) -> Option<InputEvent> {
    match event.kind {
        // 2 is autorepeat: the key is already down.
        EV_KEY if event.value != 2 => Some(InputEvent::Key {
            name: key_name(event.code)?,
            pressed: event.value == 1,
        }),
        EV_REL => match event.code {
            REL_WHEEL if event.value != 0 => {
                wheel.plain = true;
                Some(InputEvent::Wheel {
                    notches: event.value.signum(),
                })
            }
            REL_WHEEL_HI_RES if !wheel.plain => {
                wheel.high_res += event.value;
                if wheel.high_res >= HI_RES_NOTCH {
                    wheel.high_res -= HI_RES_NOTCH;
                    Some(InputEvent::Wheel { notches: 1 })
                } else if wheel.high_res <= -HI_RES_NOTCH {
                    wheel.high_res += HI_RES_NOTCH;
                    Some(InputEvent::Wheel { notches: -1 })
                } else {
                    None
                }
            }
            _ => None,
        },
        _ => None,
    }
}

/// The keys the rig reacts to, by Linux key code (physical position).
///
/// Numpad digits map to the same names as the number row so the gaze anchors
/// work from either. The mouse side buttons are forwarded too: the webview holds
/// the controls behind them, so ordinary typing never poses the face.
fn key_name(code: u16) -> Option<&'static str> {
    Some(match code {
        44 => "z",      // KEY_Z
        45 => "x",      // KEY_X
        46 => "c",      // KEY_C
        47 => "v",      // KEY_V
        48 => "b",      // KEY_B
        50 => "m",      // KEY_M: manual ↔ facial track
        19 => "r",      // KEY_R: recentre the tracked face
        32 => "d",      // KEY_D
        20 => "t",      // KEY_T: the tracking camera preview
        57 => "space",  // KEY_SPACE: lean without moving the pupils
        275 => "side",  // BTN_SIDE: the mouse's back button
        276 => "extra", // BTN_EXTRA: the mouse's forward button
        11 | 82 => "0", // KEY_0, KEY_KP0
        2 | 79 => "1",  // KEY_1, KEY_KP1
        3 | 80 => "2",  // KEY_2, KEY_KP2
        4 | 81 => "3",  // KEY_3, KEY_KP3
        5 | 75 => "4",  // KEY_4, KEY_KP4
        6 | 76 => "5",  // KEY_5, KEY_KP5
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_Z: u16 = 44;
    const KEY_A: u16 = 30;
    const KEY_KP1: u16 = 79;
    const KEY_KP0: u16 = 82;
    const BTN_SIDE: u16 = 275;
    const BTN_EXTRA: u16 = 276;

    fn key(code: u16, value: i32) -> RawEvent {
        RawEvent {
            kind: EV_KEY,
            code,
            value,
            ..RawEvent::default()
        }
    }

    fn rel(code: u16, value: i32) -> RawEvent {
        RawEvent {
            kind: EV_REL,
            code,
            value,
            ..RawEvent::default()
        }
    }

    fn name_of(event: &InputEvent) -> &'static str {
        match event {
            InputEvent::Key { name, .. } => name,
            InputEvent::Wheel { .. } => "wheel",
        }
    }

    #[test]
    fn forwards_the_control_keys() {
        let mut wheel = WheelState::default();

        let down = translate(key(KEY_Z, 1), &mut wheel).expect("press");
        assert!(matches!(down, InputEvent::Key { pressed: true, .. }));
        assert_eq!(name_of(&down), "z");

        let up = translate(key(KEY_Z, 0), &mut wheel).expect("release");
        assert!(matches!(up, InputEvent::Key { pressed: false, .. }));

        // Numpad digits share the names of the number row.
        assert_eq!(
            name_of(&translate(key(KEY_KP1, 1), &mut wheel).unwrap()),
            "1"
        );
        assert_eq!(
            name_of(&translate(key(KEY_KP0, 1), &mut wheel).unwrap()),
            "0"
        );

        // Sizing keys of the eye.
        assert_eq!(name_of(&translate(key(47, 1), &mut wheel).unwrap()), "v");
        assert_eq!(name_of(&translate(key(48, 1), &mut wheel).unwrap()), "b");

        // Mode switching and the tracking recentre.
        assert_eq!(name_of(&translate(key(50, 1), &mut wheel).unwrap()), "m");
        assert_eq!(name_of(&translate(key(19, 1), &mut wheel).unwrap()), "r");

        // The camera preview.
        assert_eq!(name_of(&translate(key(20, 1), &mut wheel).unwrap()), "t");

        // Held down, space decouples the lean from the pupils.
        assert_eq!(
            name_of(&translate(key(57, 1), &mut wheel).unwrap()),
            "space"
        );
    }

    #[test]
    fn forwards_the_mouse_side_buttons() {
        let mut wheel = WheelState::default();

        let side = translate(key(BTN_SIDE, 1), &mut wheel).expect("side press");
        assert_eq!(name_of(&side), "side");
        assert!(matches!(side, InputEvent::Key { pressed: true, .. }));

        let extra = translate(key(BTN_EXTRA, 1), &mut wheel).expect("extra press");
        assert_eq!(name_of(&extra), "extra");

        // They are the only way the controls are held, so releases matter too.
        let release = translate(key(BTN_SIDE, 0), &mut wheel).expect("side release");
        assert!(matches!(release, InputEvent::Key { pressed: false, .. }));
    }

    #[test]
    fn ignores_everything_else() {
        let mut wheel = WheelState::default();

        // Autorepeat, an unrelated key, and an unrelated relative axis.
        assert!(translate(key(KEY_Z, 2), &mut wheel).is_none());
        assert!(translate(key(KEY_A, 1), &mut wheel).is_none());
        assert!(translate(rel(0, 5), &mut wheel).is_none());
    }

    #[test]
    fn counts_plain_wheel_notches_once() {
        let mut wheel = WheelState::default();

        assert!(matches!(
            translate(rel(REL_WHEEL, 1), &mut wheel),
            Some(InputEvent::Wheel { notches: 1 })
        ));
        assert!(matches!(
            translate(rel(REL_WHEEL, -2), &mut wheel),
            Some(InputEvent::Wheel { notches: -1 })
        ));

        // Devices that report both must not scroll twice per notch.
        assert!(translate(rel(REL_WHEEL_HI_RES, 120), &mut wheel).is_none());
    }

    #[test]
    fn gathers_high_resolution_deltas_into_notches() {
        let mut wheel = WheelState::default();

        for _ in 0..3 {
            assert!(translate(rel(REL_WHEEL_HI_RES, 30), &mut wheel).is_none());
        }
        assert!(matches!(
            translate(rel(REL_WHEEL_HI_RES, 30), &mut wheel),
            Some(InputEvent::Wheel { notches: 1 })
        ));

        // The remainder carries over, so slow scrolling still adds up.
        assert!(translate(rel(REL_WHEEL_HI_RES, -60), &mut wheel).is_none());
        assert!(matches!(
            translate(rel(REL_WHEEL_HI_RES, -60), &mut wheel),
            Some(InputEvent::Wheel { notches: -1 })
        ));
    }
}
