//! Global pointer position, for eye tracking.
//!
//! Wayland never hands a client the global cursor position: tao reports (0, 0)
//! there, so a face that should follow the cursor cannot ask GTK. Hyprland does
//! expose it over its IPC socket, which this module samples on a small thread
//! and pushes to the webview, normalised to the monitor the cursor is on.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// Event the webview listens to for cursor updates.
const EVENT_NAME: &str = "pointer";

/// Cursor position inside the monitor it is on, 0..1 on each axis.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct PointerSample {
    pub u: f64,
    pub v: f64,
}

/// How often the compositor is asked where the cursor is.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(40);
/// The monitor layout barely ever changes; refetching it is not free.
const MONITOR_TTL: Duration = Duration::from_secs(10);
/// A compositor that does not answer must never wedge the sampling thread.
const REPLY_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone, Copy)]
struct Monitor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Starts sampling the cursor and pushing samples to the webview.
///
/// Does nothing when there is no Hyprland socket to talk to, in which case the
/// UI falls back to pointer events inside its window.
pub fn start(app: AppHandle) {
    let Some(socket) = socket_path() else {
        return;
    };

    thread::spawn(move || {
        let mut monitors = Monitors::default();
        loop {
            let sample = cursor_position(&socket).and_then(|(x, y)| monitors.locate(&socket, x, y));

            // Pushed rather than polled: the webview throttles timers when its
            // window is hidden, and the eyes must keep following anyway.
            if let Some(sample) = sample {
                let _ = app.emit(EVENT_NAME, sample);
            }

            thread::sleep(SAMPLE_INTERVAL);
        }
    });
}

#[derive(Default)]
struct Monitors {
    list: Vec<Monitor>,
    fetched: Option<Instant>,
}

impl Monitors {
    fn locate(&mut self, socket: &Path, x: f64, y: f64) -> Option<PointerSample> {
        let stale = self
            .fetched
            .is_none_or(|when| when.elapsed() >= MONITOR_TTL);
        if stale {
            if let Some(list) = fetch_monitors(socket) {
                self.list = list;
                self.fetched = Some(Instant::now());
            }
        }

        let monitor = self
            .list
            .iter()
            .find(|monitor| {
                x >= monitor.x
                    && x < monitor.x + monitor.width
                    && y >= monitor.y
                    && y < monitor.y + monitor.height
            })
            .or_else(|| self.list.first())?;

        Some(PointerSample {
            u: ((x - monitor.x) / monitor.width).clamp(0.0, 1.0),
            v: ((y - monitor.y) / monitor.height).clamp(0.0, 1.0),
        })
    }
}

/// Hyprland keeps its sockets under the runtime dir, or `/tmp/hypr` on older
/// builds. The instance signature is the only thing that identifies them.
fn socket_path() -> Option<PathBuf> {
    let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
    let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".to_string());
    let roots = [format!("{runtime}/hypr"), "/tmp/hypr".to_string()];

    roots
        .iter()
        .map(|root| Path::new(root).join(&signature).join(".socket.sock"))
        .find(|path| path.exists())
}

fn cursor_position(socket: &Path) -> Option<(f64, f64)> {
    let reply = query(socket, "cursorpos")?;
    let (x, y) = reply.trim().split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

fn fetch_monitors(socket: &Path) -> Option<Vec<Monitor>> {
    // The `j/` prefix is how hyprctl asks for JSON instead of the pretty text.
    let reply = query(socket, "j/monitors")?;
    let parsed: Value = serde_json::from_str(&reply).ok()?;

    let monitors: Vec<Monitor> = parsed
        .as_array()?
        .iter()
        .filter_map(|entry| {
            let width = entry["width"].as_f64()?;
            let height = entry["height"].as_f64()?;
            if width <= 0.0 || height <= 0.0 {
                return None;
            }

            Some(Monitor {
                x: entry["x"].as_f64()?,
                y: entry["y"].as_f64()?,
                width,
                height,
            })
        })
        .collect();

    (!monitors.is_empty()).then_some(monitors)
}

/// One request/response exchange with the compositor.
///
/// Hyprland answers the command socket and closes it, except for event
/// streams, so reading until end of file gives the whole reply: a single read
/// can stop halfway through the monitor JSON.
fn query(socket: &Path, command: &str) -> Option<String> {
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.set_read_timeout(Some(REPLY_TIMEOUT)).ok()?;
    stream.write_all(command.as_bytes()).ok()?;

    let mut reply = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => reply.extend_from_slice(&buffer[..read]),
        }
    }

    (!reply.is_empty()).then(|| String::from_utf8_lossy(&reply).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test against the running compositor; skipped where there is none.
    #[test]
    fn tracks_the_cursor_on_a_hyprland_session() {
        let Some(socket) = socket_path() else {
            return;
        };

        let cursor = cursor_position(&socket).expect("cursor position");
        assert!(socket.exists());

        let mut lookup = Monitors::default();
        let sample = lookup.locate(&socket, cursor.0, cursor.1).expect("sample");
        assert!((0.0..=1.0).contains(&sample.u));
        assert!((0.0..=1.0).contains(&sample.v));
    }
}
