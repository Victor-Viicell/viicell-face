//! Frame timing for the webview.
//!
//! `requestAnimationFrame` is driven by the compositor's frame callbacks, and a
//! window on another workspace never gets any: rAF slows to about one frame a
//! second and the virtual camera would freeze. These ticks come from the app's
//! own thread instead, so the face is rendered at the output rate wherever the
//! window happens to be.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

const EVENT_NAME: &str = "frame-tick";

/// Emits a tick at the output rate, forever.
pub struct Ticker {
    rate: Arc<AtomicU32>,
}

impl Ticker {
    pub fn start(app: AppHandle, fps: u32) -> Ticker {
        let rate = Arc::new(AtomicU32::new(clamped(fps)));
        let ticking = Arc::clone(&rate);

        thread::spawn(move || {
            loop {
                let interval =
                    Duration::from_micros(1_000_000 / u64::from(ticking.load(Ordering::Relaxed)));
                let started = Instant::now();
                let _ = app.emit(EVENT_NAME, ());
                thread::sleep(interval.saturating_sub(started.elapsed()));
            }
        });

        Ticker { rate }
    }

    /// Matches the tick rate to the rate frames are written at.
    pub fn set_rate(&self, fps: u32) {
        self.rate.store(clamped(fps), Ordering::Relaxed);
    }
}

fn clamped(fps: u32) -> u32 {
    fps.clamp(1, 120)
}
