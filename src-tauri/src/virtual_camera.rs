//! Pushes frames rendered by the webview into a `v4l2loopback` device.
//!
//! The device shows up in every camera picker on the machine (browsers, Zoom,
//! OBS, ...) exactly like a webcam, so the PixiJS canvas becomes the video the
//! rest of the system captures.
//!
//! Threading model:
//!
//! * the IPC command (`push_frame`) only copies the RGBA buffer into a
//!   single-slot channel, so the webview is never blocked on device I/O;
//! * a writer thread owns the v4l2 device, converts RGBA -> YUYV and streams it
//!   out at the configured rate, repeating the last frame when the canvas goes
//!   quiet (hidden window). When the channel is full the extra frame is
//!   dropped, which keeps latency at one frame no matter how fast the canvas
//!   renders.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use v4l::buffer::Type;
use v4l::capability::Flags as CapabilityFlags;
use v4l::device::Device;
use v4l::format::{Format, FourCC};
use v4l::io::mmap::Stream as MmapStream;
use v4l::io::traits::OutputStream;
use v4l::video::Output;

/// Card label the app gives its own device, and the one it prefers to stream to
/// when the machine exposes several loopback devices.
pub const PREFERRED_LABEL: &str = "viicell-face";

/// Overrides auto-detection, e.g. `VIICELL_VIDEO_DEVICE=/dev/video11`.
const DEVICE_ENV: &str = "VIICELL_VIDEO_DEVICE";

const SYSFS_VIDEO_CLASS: &str = "/sys/class/video4linux";

/// v4l2loopback accepts up to `max_buffers` (4 in the recommended setup).
const BUFFER_COUNT: u32 = 4;

/// How long the writer waits for device buffer space before retrying.
const FRAME_WAIT: Duration = Duration::from_millis(250);

/// How long `start` waits for the writer thread to open the device.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// YUYV is the one format every V4L2 consumer (Chromium, Firefox, GStreamer,
/// ffmpeg) understands, so it is the safest thing to advertise on the device.
const PIXEL_FORMAT: [u8; 4] = *b"YUYV";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub path: String,
    pub label: String,
    pub driver: String,
    /// True for v4l2loopback style devices, i.e. the ones we can feed.
    pub is_loopback: bool,
    pub can_output: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInfo {
    pub device: DeviceInfo,
    pub width: u32,
    pub height: u32,
    /// Output rate the device is kept at, even when no new frames arrive.
    pub fps: u32,
    pub pixel_format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraStatus {
    pub running: bool,
    pub info: Option<CameraInfo>,
    pub frames_received: u64,
    pub frames_dropped: u64,
    pub frames_written: u64,
    /// Frames per second actually written to the device, averaged over ~1s.
    pub fps: f32,
    pub error: Option<String>,
}

impl CameraStatus {
    pub fn idle(error: Option<String>) -> Self {
        Self {
            running: false,
            info: None,
            frames_received: 0,
            frames_dropped: 0,
            frames_written: 0,
            fps: 0.0,
            error,
        }
    }
}

#[derive(Default)]
struct Stats {
    received: AtomicU64,
    dropped: AtomicU64,
    written: AtomicU64,
    /// FPS multiplied by 100, stored as an integer to avoid locking.
    fps_centi: AtomicU32,
    error: Mutex<Option<String>>,
}

impl Stats {
    /// Records the first error only: it explains the failure, the rest is fallout.
    fn note_error(&self, message: impl Into<String>) {
        if let Ok(mut slot) = self.error.lock() {
            if slot.is_none() {
                *slot = Some(message.into());
            }
        }
    }

    fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|slot| slot.clone())
    }
}

/// A running virtual camera. Dropping it stops streaming and releases the device.
pub struct Camera {
    tx: Option<SyncSender<Vec<u8>>>,
    join: Option<JoinHandle<()>>,
    info: CameraInfo,
    stats: Arc<Stats>,
    alive: Arc<AtomicBool>,
}

impl Camera {
    /// Claims a loopback device and starts its writer thread.
    ///
    /// `width` and `height` must match the frames that will be pushed
    /// (RGBA, 4 bytes per pixel, top-left origin). `fps` is the rate the device
    /// is kept at: when the canvas stops sending frames (hidden window), the
    /// last frame is repeated instead of letting the stream stall.
    pub fn start(width: u32, height: u32, fps: u32) -> Result<Self, String> {
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return Err(format!(
                "invalid frame size {width}x{height}: YUYV needs non-zero, even dimensions"
            ));
        }
        if !(1..=240).contains(&fps) {
            return Err(format!("invalid frame rate {fps}: expected 1-240"));
        }

        let device = find_device()?;
        let stats = Arc::new(Stats::default());
        let alive = Arc::new(AtomicBool::new(true));

        // A single slot is enough: if the writer lags behind, the newest frame
        // replaces the pending one instead of building up a backlog.
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(1);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<CameraInfo, String>>();

        let thread_alive = alive.clone();
        let thread_stats = stats.clone();
        let device_path = device.path.clone();
        let join = thread::Builder::new()
            .name("viicell-virtual-camera".into())
            .spawn(move || {
                run_writer(rx, device, width, height, fps, thread_stats, ready_tx);
                thread_alive.store(false, Ordering::Release);
            })
            .map_err(|err| format!("failed to spawn the camera thread: {err}"))?;

        match ready_rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(info)) => Ok(Self {
                tx: Some(tx),
                join: Some(join),
                info,
                stats,
                alive,
            }),
            Ok(Err(err)) => {
                let _ = join.join();
                Err(err)
            }
            Err(_) => {
                drop(tx);
                let _ = join.join();
                Err(format!(
                    "timed out while opening {device_path}; the device may be busy"
                ))
            }
        }
    }

    pub fn info(&self) -> &CameraInfo {
        &self.info
    }

    /// Queues one RGBA frame. Never blocks: returns immediately when the
    /// writer already has a frame pending.
    pub fn push(&self, frame: &[u8]) {
        self.stats.received.fetch_add(1, Ordering::Relaxed);

        let expected = (self.info.width as usize) * (self.info.height as usize) * 4;
        if frame.len() != expected {
            self.stats.note_error(format!(
                "expected a {expected} byte RGBA frame, received {} bytes",
                frame.len()
            ));
            return;
        }

        let Some(tx) = self.tx.as_ref() else {
            return;
        };
        match tx.try_send(frame.to_vec()) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.stats.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {
                self.stats.dropped.fetch_add(1, Ordering::Relaxed);
                self.stats
                    .note_error("the camera writer stopped unexpectedly");
                self.alive.store(false, Ordering::Release);
            }
        }
    }

    pub fn status(&self) -> CameraStatus {
        CameraStatus {
            running: self.alive.load(Ordering::Acquire),
            info: Some(self.info.clone()),
            frames_received: self.stats.received.load(Ordering::Relaxed),
            frames_dropped: self.stats.dropped.load(Ordering::Relaxed),
            frames_written: self.stats.written.load(Ordering::Relaxed),
            fps: self.stats.fps_centi.load(Ordering::Relaxed) as f32 / 100.0,
            error: self.stats.error(),
        }
    }
}

impl Drop for Camera {
    fn drop(&mut self) {
        // Closing the channel makes the writer notice and wind down.
        self.tx.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Every video device on the machine. Physical cameras are listed but can never
/// be written to; only loopback devices are candidates for streaming.
pub fn list_devices() -> Vec<DeviceInfo> {
    let mut devices = Vec::new();
    let mut entries: Vec<PathBuf> = match fs::read_dir(SYSFS_VIDEO_CLASS) {
        Ok(read_dir) => read_dir
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .collect(),
        Err(_) => return devices,
    };
    entries.sort_by_key(|path| video_index(path).unwrap_or(u32::MAX));

    for sysfs_path in entries {
        let Some(node_name) = sysfs_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let node = Path::new("/dev").join(node_name);
        if !node.exists() {
            continue;
        }

        if is_virtual_device(&sysfs_path) {
            if let Some(info) = probe(&node) {
                devices.push(info);
            }
        } else {
            // Do not open physical cameras: they may be busy, and they can
            // never be a sink for our frames.
            devices.push(DeviceInfo {
                path: node.display().to_string(),
                label: read_sysfs_string(&sysfs_path.join("name")),
                driver: "v4l2".to_string(),
                is_loopback: false,
                can_output: false,
            });
        }
    }

    devices
}

/// Picks the device to stream to.
fn find_device() -> Result<DeviceInfo, String> {
    if let Some(explicit) = std::env::var_os(DEVICE_ENV) {
        let path = PathBuf::from(explicit);
        return probe(&path).ok_or_else(|| {
            format!(
                "{DEVICE_ENV}={} could not be opened as a video device",
                path.display()
            )
        });
    }

    let loopbacks: Vec<DeviceInfo> = list_devices()
        .into_iter()
        .filter(|device| device.is_loopback && device.can_output)
        .collect();

    if loopbacks.is_empty() {
        return Err(
            "no v4l2loopback device found; run `sudo scripts/setup-virtual-camera.sh` to create one"
                .to_string(),
        );
    }

    let preferred = loopbacks
        .iter()
        .find(|device| device.label.to_ascii_lowercase().contains(PREFERRED_LABEL));
    Ok(preferred.unwrap_or(&loopbacks[0]).clone())
}

fn probe(node: &Path) -> Option<DeviceInfo> {
    let device = Device::with_path(node).ok()?;
    let caps = device.query_caps().ok()?;
    let is_loopback = caps.driver.contains("loopback");
    let capabilities = caps.capabilities;

    Some(DeviceInfo {
        path: node.display().to_string(),
        label: caps.card,
        driver: caps.driver,
        is_loopback,
        // `exclusive_caps` hides the output capability while no producer is
        // attached, so a loopback device is assumed writable.
        can_output: is_loopback
            || (capabilities.contains(CapabilityFlags::VIDEO_OUTPUT)
                && capabilities.contains(CapabilityFlags::STREAMING)),
    })
}

fn is_virtual_device(sysfs_path: &Path) -> bool {
    fs::canonicalize(sysfs_path)
        .map(|resolved| resolved.starts_with("/sys/devices/virtual/"))
        .unwrap_or(false)
}

fn video_index(sysfs_path: &Path) -> Option<u32> {
    sysfs_path
        .file_name()?
        .to_str()?
        .strip_prefix("video")?
        .parse()
        .ok()
}

fn read_sysfs_string(path: &Path) -> String {
    fs::read_to_string(path)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn run_writer(
    rx: Receiver<Vec<u8>>,
    device: DeviceInfo,
    width: u32,
    height: u32,
    fps: u32,
    stats: Arc<Stats>,
    ready: Sender<Result<CameraInfo, String>>,
) {
    let node = PathBuf::from(&device.path);
    let device_path = device.path.clone();

    let dev = match Device::with_path(&node) {
        Ok(dev) => dev,
        Err(err) => {
            let _ = ready.send(Err(format!("failed to open {device_path}: {err}")));
            return;
        }
    };

    let desired = Format::new(width, height, FourCC::new(&PIXEL_FORMAT));
    let applied = match Output::set_format(&dev, &desired) {
        Ok(format) => format,
        Err(err) => {
            let _ = ready.send(Err(format!(
                "failed to set {width}x{height} {} on {device_path}: {err}",
                String::from_utf8_lossy(&PIXEL_FORMAT)
            )));
            return;
        }
    };

    if applied.fourcc != desired.fourcc {
        let _ = ready.send(Err(format!(
            "{device_path} refused {} and fell back to {}",
            String::from_utf8_lossy(&PIXEL_FORMAT),
            applied.fourcc
        )));
        return;
    }
    if applied.width != width || applied.height != height {
        let _ = ready.send(Err(format!(
            "{device_path} clamped the frame size to {}x{}",
            applied.width, applied.height
        )));
        return;
    }

    // Drivers are allowed to pad rows; YUYV is 2 bytes per pixel.
    let stride = (applied.stride as usize).max(width as usize * 2);
    let frame_bytes = stride * height as usize;

    let mut stream = match MmapStream::with_buffers(&dev, Type::VideoOutput, BUFFER_COUNT) {
        Ok(stream) => stream,
        Err(err) => {
            let _ = ready.send(Err(format!(
                "failed to allocate output buffers on {device_path}: {err}"
            )));
            return;
        }
    };
    stream.set_timeout(FRAME_WAIT);

    let info = CameraInfo {
        device,
        width,
        height,
        fps,
        pixel_format: String::from_utf8_lossy(&PIXEL_FORMAT).into_owned(),
    };
    if ready.send(Ok(info)).is_err() {
        return;
    }

    let rgba_bytes = width as usize * height as usize * 4;
    let mut yuyv = vec![0u8; frame_bytes];
    let mut has_frame = false;
    let mut window_started = Instant::now();
    let mut window_frames = 0u32;
    let frame_wait = Duration::from_micros(1_000_000 / u64::from(fps));

    loop {
        match rx.recv_timeout(frame_wait) {
            Ok(frame) => {
                if frame.len() != rgba_bytes {
                    stats.note_error(format!(
                        "expected a {rgba_bytes} byte RGBA frame, received {} bytes",
                        frame.len()
                    ));
                    continue;
                }
                rgba_to_yuyv(&frame, &mut yuyv, width as usize, height as usize, stride);
                has_frame = true;
            }
            // Nothing new (hidden window, throttled webview): keep sending the
            // last picture so consumers never see the stream stall.
            Err(RecvTimeoutError::Timeout) => {
                if !has_frame {
                    continue;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }

        let (buffer, meta) = match stream.next() {
            Ok(pair) => pair,
            // The device had no free buffer within the timeout: try again with
            // the next frame instead of tearing the stream down.
            Err(err) if err.kind() == io::ErrorKind::TimedOut => continue,
            Err(err) => {
                stats.note_error(format!("writing to {device_path} failed: {err}"));
                break;
            }
        };

        if buffer.len() < frame_bytes {
            stats.note_error(format!(
                "device buffer is {} bytes, a frame needs {frame_bytes}",
                buffer.len()
            ));
            break;
        }

        buffer[..frame_bytes].copy_from_slice(&yuyv);
        meta.bytesused = frame_bytes as u32;
        meta.field = 0;

        stats.written.fetch_add(1, Ordering::Relaxed);
        window_frames += 1;

        let elapsed = window_started.elapsed();
        if elapsed >= Duration::from_secs(1) {
            let fps = f64::from(window_frames) / elapsed.as_secs_f64();
            stats
                .fps_centi
                .store((fps * 100.0).round() as u32, Ordering::Relaxed);
            window_started = Instant::now();
            window_frames = 0;
        }
    }
    // Dropping `stream` issues STREAMOFF, so consumers see the camera go idle.
}

/// Converts packed RGBA (PixiJS readback) into packed YUYV 4:2:2.
///
/// Uses the integer BT.601 coefficients, which is what webcams produce: luma
/// per pixel, chroma averaged over each horizontal pixel pair.
fn rgba_to_yuyv(src: &[u8], dst: &mut [u8], width: usize, height: usize, stride: usize) {
    debug_assert!(width % 2 == 0);
    debug_assert!(src.len() >= width * height * 4);
    debug_assert!(dst.len() >= stride * height);

    for y in 0..height {
        let src_row = &src[y * width * 4..(y + 1) * width * 4];
        let dst_row = &mut dst[y * stride..y * stride + width * 2];

        for (pair_index, pair) in dst_row.chunks_exact_mut(4).enumerate() {
            let left = pair_index * 8;
            let right = left + 4;

            let r0 = i32::from(src_row[left]);
            let g0 = i32::from(src_row[left + 1]);
            let b0 = i32::from(src_row[left + 2]);
            let r1 = i32::from(src_row[right]);
            let g1 = i32::from(src_row[right + 1]);
            let b1 = i32::from(src_row[right + 2]);

            let y0 = ((66 * r0 + 129 * g0 + 25 * b0 + 128) >> 8) + 16;
            let y1 = ((66 * r1 + 129 * g1 + 25 * b1 + 128) >> 8) + 16;

            let r = (r0 + r1) >> 1;
            let g = (g0 + g1) >> 1;
            let b = (b0 + b1) >> 1;
            let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
            let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;

            pair[0] = y0.clamp(0, 255) as u8;
            pair[1] = u.clamp(0, 255) as u8;
            pair[2] = y1.clamp(0, 255) as u8;
            pair[3] = v.clamp(0, 255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_white_to_full_luma() {
        let src = [255u8; 2 * 1 * 4];
        let mut dst = [0u8; 2 * 1 * 2];
        rgba_to_yuyv(&src, &mut dst, 2, 1, 4);

        assert_eq!(dst, [235, 128, 235, 128]);
    }

    #[test]
    fn converts_black_to_limited_range_luma() {
        let mut src = [0u8; 2 * 1 * 4];
        for alpha in src.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }
        let mut dst = [0u8; 2 * 1 * 2];
        rgba_to_yuyv(&src, &mut dst, 2, 1, 4);

        assert_eq!(dst, [16, 128, 16, 128]);
    }

    #[test]
    fn averages_chroma_over_a_pixel_pair() {
        // Left pixel red, right pixel blue: luma stays per pixel, chroma is the mix.
        let src = [255, 0, 0, 255, 0, 0, 255, 255];
        let mut dst = [0u8; 4];
        rgba_to_yuyv(&src, &mut dst, 2, 1, 4);

        assert_eq!(dst[0], 82);
        assert_eq!(dst[2], 41);
        assert_eq!(dst[1], 165);
        assert_eq!(dst[3], 175);
    }

    #[test]
    fn respects_row_padding() {
        let src = [255u8; 2 * 2 * 4];
        let mut dst = [7u8; 8 * 2]; // stride 8 instead of 4
        rgba_to_yuyv(&src, &mut dst, 2, 2, 8);

        assert_eq!(&dst[0..4], &[235, 128, 235, 128]);
        assert_eq!(&dst[4..8], &[7, 7, 7, 7]);
        assert_eq!(&dst[8..12], &[235, 128, 235, 128]);
    }
}
