//! Camera capture for the facial-tracking mode.
//!
//! The tracking itself runs in the webview (MediaPipe FaceLandmarker, WASM),
//! but the frames come from here. The webview's own `getUserMedia` needs
//! WebKitGTK's GStreamer capture stack, which not every install has, and it also
//! stops feeding while the window is hidden. A native capture thread keeps
//! handing frames out whatever the window is doing.
//!
//! Frames stay in the compressed JPEG the camera produces: 15 frames of 640×480
//! MJPG are a few hundred kilobytes per second, where raw YUYV would be ~9 MB/s
//! across the USB bus.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Serialize;
use v4l::buffer::Type;
use v4l::format::{Format, FourCC};
use v4l::io::mmap::Stream;
use v4l::io::traits::CaptureStream;
use v4l::prelude::Device;
use v4l::video::Capture;
use v4l::video::capture::Parameters;

/// Overrides the camera used for tracking, e.g. `VIICELL_FACE_DEVICE=/dev/video2`.
const DEVICE_ENV: &str = "VIICELL_FACE_DEVICE";
const SYSFS_VIDEO_CLASS: &str = "/sys/class/video4linux";

/// Tracking resolution. The landmark model works on small tiles, so a larger
/// frame buys no accuracy — it only costs USB bandwidth and decode time.
pub const WIDTH: u32 = 640;
pub const HEIGHT: u32 = 480;
/// Frames per second the camera is asked for. The tracker runs the landmark
/// model on every new frame, so this is the sampling rate of the mouth and
/// eyelids: fast enough to catch the peaks of speech rather than skipping them.
pub const FPS: u32 = 30;

/// How long `start` waits for the device to open and start streaming.
const OPEN_TIMEOUT: Duration = Duration::from_secs(6);
/// How long the loop sleeps on the device before checking for a stop request.
const POLL_TIMEOUT_MS: i32 = 250;

const MJPG: [u8; 4] = *b"MJPG";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceCameraInfo {
    pub path: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceCameraStatus {
    pub running: bool,
    pub info: Option<FaceCameraInfo>,
    /// Frames captured since the camera was opened.
    pub frames: u64,
    pub error: Option<String>,
}

impl FaceCameraStatus {
    pub fn idle(error: Option<String>) -> Self {
        Self {
            running: false,
            info: None,
            frames: 0,
            error,
        }
    }
}

/// A running face camera. Dropping it stops the capture thread and releases the
/// device, so switching back to manual mode gives the camera back to other apps.
pub struct FaceCamera {
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    /// Incremented for every captured frame.
    version: Arc<AtomicU64>,
    /// Version last handed to the webview, so a poll that arrives between two
    /// camera frames gets nothing to decode instead of the same JPEG again.
    sent: Arc<AtomicU64>,
    frames: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
    alive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    info: FaceCameraInfo,
    join: Option<JoinHandle<()>>,
}

impl FaceCamera {
    /// Opens a camera and starts its capture thread.
    pub fn start() -> Result<Self, String> {
        let node = find_device()?;
        let info = FaceCameraInfo {
            path: node.display().to_string(),
            // Filled in by the capture thread once the device is open.
            label: String::new(),
            width: WIDTH,
            height: HEIGHT,
            fps: FPS,
        };

        let latest = Arc::new(Mutex::new(None));
        let version = Arc::new(AtomicU64::new(0));
        let sent = Arc::new(AtomicU64::new(0));
        let frames = Arc::new(AtomicU64::new(0));
        let error = Arc::new(Mutex::new(None));
        let alive = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<FaceCameraInfo, String>>();

        let thread_latest = latest.clone();
        let thread_version = version.clone();
        let thread_frames = frames.clone();
        let thread_error = error.clone();
        let thread_alive = alive.clone();
        let thread_stop = stop.clone();
        let thread_info = info.clone();
        let thread_node = node.clone();

        let join = thread::Builder::new()
            .name("viicell-face-camera".into())
            .spawn(move || {
                run_capture(
                    &thread_node,
                    thread_info,
                    thread_latest,
                    thread_version,
                    thread_frames,
                    thread_error,
                    thread_alive,
                    thread_stop,
                    ready_tx,
                );
            })
            .map_err(|err| format!("failed to spawn the face camera thread: {err}"))?;

        match ready_rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(info)) => Ok(Self {
                latest,
                version,
                sent,
                frames,
                error,
                alive,
                stop,
                info,
                join: Some(join),
            }),
            Ok(Err(err)) => {
                stop.store(true, Ordering::Release);
                let _ = join.join();
                Err(err)
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                Err(format!(
                    "timed out while opening {}; another app may be using the camera",
                    node.display()
                ))
            }
        }
    }

    /// The newest JPEG frame, or an empty vector when there is nothing new.
    ///
    /// Cloning ~30 kB per call keeps the capture thread from ever waiting on the
    /// webview; the frontend asks for a frame at its own pace. Polling faster
    /// than the camera captures returns nothing, so the same picture is never
    /// run through the landmark model twice.
    pub fn frame(&self) -> Vec<u8> {
        let version = self.version.load(Ordering::Acquire);
        if version == 0 || version == self.sent.load(Ordering::Acquire) {
            return Vec::new();
        }
        self.sent.store(version, Ordering::Release);

        self.latest
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .unwrap_or_default()
    }

    pub fn status(&self) -> FaceCameraStatus {
        FaceCameraStatus {
            running: self.alive.load(Ordering::Acquire),
            info: Some(self.info.clone()),
            frames: self.frames.load(Ordering::Relaxed),
            error: self.error.lock().ok().and_then(|slot| slot.clone()),
        }
    }
}

impl Drop for FaceCamera {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            // The loop wakes on its device poll within POLL_TIMEOUT_MS.
            let _ = join.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_capture(
    node: &Path,
    mut info: FaceCameraInfo,
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    version: Arc<AtomicU64>,
    frames: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
    alive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    ready: Sender<Result<FaceCameraInfo, String>>,
) {
    let fail = |message: String| {
        if let Ok(mut slot) = error.lock() {
            *slot = Some(message.clone());
        }
        alive.store(false, Ordering::Release);
        let _ = ready.send(Err(message));
    };

    let device = match Device::with_path(node) {
        Ok(device) => device,
        Err(err) => {
            fail(format!("cannot open {}: {err}", node.display()));
            return;
        }
    };

    if let Ok(caps) = device.query_caps() {
        info.label = caps.card;
    }

    // The camera is asked for MJPG explicitly: its default may be raw YUYV,
    // which is both slower to move and slower to decode.
    if let Err(err) = set_format(&device, WIDTH, HEIGHT) {
        fail(format!(
            "{} cannot capture MJPG {WIDTH}×{HEIGHT}: {err}",
            info.path
        ));
        return;
    }
    // Best effort: some cameras ignore the frame interval and pick their own.
    let _ = device.set_params(&Parameters::with_fps(FPS));

    let mut stream = match Stream::with_buffers(&device, Type::VideoCapture, 4) {
        Ok(stream) => stream,
        Err(err) => {
            fail(format!("cannot start streaming on {}: {err}", info.path));
            return;
        }
    };
    let handle = stream.handle();

    if ready.send(Ok(info)).is_err() {
        return;
    }

    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }

        // Wait for a filled buffer before queueing the previous one back: a
        // blocking dequeue with a library timeout would leave the buffer queued
        // twice on wake-up, which the driver rejects.
        match handle.poll(libc::POLLIN, POLL_TIMEOUT_MS) {
            Ok(0) => continue,
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => {
                note_error(&error, format!("camera read failed: {err}"));
                break;
            }
        }

        match stream.next() {
            Ok((buffer, meta)) => {
                let len = (meta.bytesused as usize).min(buffer.len());
                let data = trim_jpeg(&buffer[..len]);
                if !data.is_empty() {
                    if let Ok(mut slot) = latest.lock() {
                        *slot = Some(data.to_vec());
                    }
                    version.fetch_add(1, Ordering::Release);
                    frames.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(err) => {
                note_error(&error, format!("camera stopped: {err}"));
                break;
            }
        }
    }

    alive.store(false, Ordering::Release);
}

fn set_format(device: &Device, width: u32, height: u32) -> io::Result<Format> {
    let fourcc = FourCC::new(&MJPG);
    let format = Format::new(width, height, fourcc);
    let applied = device.set_format(&format)?;
    if applied.width != width || applied.height != height || applied.fourcc != fourcc {
        return Err(io::Error::other(format!(
            "driver chose {}×{} {}",
            applied.width, applied.height, applied.fourcc
        )));
    }
    Ok(applied)
}

fn note_error(slot: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut current) = slot.lock() {
        if current.is_none() {
            *current = Some(message);
        }
    }
}

/// A JPEG stream starts with SOI (FF D8). Some drivers hand over buffers that
/// still carry a stale prefix, so anything else is dropped rather than decoded.
fn is_jpeg(buffer: &[u8]) -> bool {
    buffer.len() > 2 && buffer[0] == 0xFF && buffer[1] == 0xD8
}

/// Cuts a buffer down to the JPEG it carries.
///
/// UVC drivers report the whole mmap buffer as used, not the size of the JPEG
/// inside it, so a 640×480 frame arrives padded to ~600 kB. Trimming at the EOI
/// marker (FF D9) makes the IPC payload proportional to the picture instead of
/// the buffer — a typical frame is a few tens of kilobytes.
fn trim_jpeg(buffer: &[u8]) -> &[u8] {
    if !is_jpeg(buffer) {
        return &[];
    }
    match buffer.windows(2).rposition(|pair| pair == [0xFF, 0xD9]) {
        Some(end) => &buffer[..end + 2],
        None => buffer,
    }
}

/// Picks the camera to track from.
///
/// Physical capture nodes are the only candidates: loopback devices carry our
/// own output, and metadata nodes expose no pictures.
fn find_device() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os(DEVICE_ENV) {
        let path = PathBuf::from(explicit);
        if probe_capture(&path).is_some() {
            return Ok(path);
        }
        return Err(format!(
            "{DEVICE_ENV}={} is not a usable camera",
            path.display()
        ));
    }

    let mut entries: Vec<PathBuf> = match fs::read_dir(SYSFS_VIDEO_CLASS) {
        Ok(read_dir) => read_dir
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .collect(),
        Err(_) => Vec::new(),
    };
    entries.sort_by_key(|path| video_index(path).unwrap_or(u32::MAX));

    for sysfs_path in entries {
        let Some(name) = sysfs_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let node = Path::new("/dev").join(name);
        if !node.exists() {
            continue;
        }
        if probe_capture(&node).is_some() {
            return Ok(node);
        }
    }

    Err(format!(
        "no camera found; plug one in or set {DEVICE_ENV}=/dev/videoN"
    ))
}

/// Returns the camera's card name when the node can capture video.
fn probe_capture(node: &Path) -> Option<String> {
    let device = Device::with_path(node).ok()?;
    let caps = device.query_caps().ok()?;
    let capabilities = caps.capabilities;
    let capture = capabilities.contains(v4l::capability::Flags::VIDEO_CAPTURE)
        && capabilities.contains(v4l::capability::Flags::STREAMING);
    if !capture || caps.driver.to_ascii_lowercase().contains("loopback") {
        return None;
    }
    Some(caps.card)
}

fn video_index(sysfs_path: &Path) -> Option<u32> {
    sysfs_path
        .file_name()?
        .to_str()?
        .strip_prefix("video")?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_jpeg_frame() {
        assert!(is_jpeg(&[0xFF, 0xD8, 0xFF, 0xE0]));
    }

    #[test]
    fn rejects_other_payloads() {
        assert!(!is_jpeg(&[]));
        assert!(!is_jpeg(&[0xFF, 0xD8]));
        assert!(!is_jpeg(&[0x00, 0x00, 0xFF, 0xD8]));
    }

    #[test]
    fn trims_the_padding_after_the_jpeg() {
        let frame = [0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9, 0x00, 0x00];
        assert_eq!(trim_jpeg(&frame), &[0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9]);
        assert!(trim_jpeg(&[0x00, 0xFF, 0xD8]).is_empty());
        // No EOI: keep what is there rather than dropping a frame the decoder may
        // still accept.
        assert_eq!(trim_jpeg(&[0xFF, 0xD8, 0x01]), &[0xFF, 0xD8, 0x01]);
    }

    /// Run with `cargo test --lib -- --ignored captures_a_frame`.
    #[test]
    #[ignore = "opens the webcam"]
    fn captures_a_frame() {
        let camera = FaceCamera::start().expect("the camera should open");
        let mut frame = Vec::new();
        for _ in 0..50 {
            thread::sleep(Duration::from_millis(100));
            frame = camera.frame();
            if !frame.is_empty() {
                break;
            }
        }
        assert!(is_jpeg(&frame), "no JPEG frame arrived");
        assert!(frame.len() > 1000, "frame is only {} bytes", frame.len());
        assert!(camera.status().frames > 0);
        println!(
            "captured {} bytes, {} frames, status {:?}",
            frame.len(),
            camera.status().frames,
            camera.status()
        );
    }
}
