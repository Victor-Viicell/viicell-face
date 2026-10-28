//! Microphone capture for the synth mouth.
//!
//! Raw audio never crosses the IPC boundary: the capture callback folds each
//! window of samples into a small waveform, and a worker pushes it to the
//! webview ~50 times per second. The mouth only needs the shape, not the audio.
//!
//! Capturing here instead of through `getUserMedia` keeps the app independent
//! of the webview's media stack (WebKitGTK needs a full GStreamer install to
//! capture audio) and keeps the level meter alive while the window is hidden.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Samples in one emitted waveform.
pub const POINTS: usize = 160;
/// Input samples folded into one waveform (~21 ms at 48 kHz).
const WINDOW: usize = 1024;
/// How often a new waveform is pushed to the webview.
const EMIT_INTERVAL: Duration = Duration::from_millis(20);
/// How long `start` waits for the device to open.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// Event the webview listens to; the payload is `POINTS` bytes, 128 = silence.
pub const WAVE_EVENT: &str = "mic-wave";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneStatus {
    pub running: bool,
    pub device: Option<String>,
    pub sample_rate: Option<u32>,
    pub error: Option<String>,
}

impl MicrophoneStatus {
    pub fn inactive(error: Option<String>) -> Self {
        Self {
            running: false,
            device: None,
            sample_rate: None,
            error,
        }
    }
}

/// Latest waveform, shared between the audio callback and the emitter.
struct Waveform {
    samples: Mutex<[u8; POINTS]>,
    version: AtomicU64,
}

impl Waveform {
    fn new() -> Self {
        Self {
            samples: Mutex::new([128u8; POINTS]),
            version: AtomicU64::new(0),
        }
    }

    /// Called from the audio callback: never blocks, skips a busy frame.
    fn publish(&self, samples: &[u8; POINTS]) {
        if let Ok(mut slot) = self.samples.try_lock() {
            slot.copy_from_slice(samples);
            self.version.fetch_add(1, Ordering::Release);
        }
    }

    /// Copies the latest waveform out and returns its version.
    fn snapshot(&self, out: &mut [u8; POINTS]) -> u64 {
        if let Ok(slot) = self.samples.lock() {
            out.copy_from_slice(&*slot);
        }
        self.version.load(Ordering::Acquire)
    }
}

pub struct Microphone {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    device: Option<String>,
    sample_rate: Option<u32>,
}

impl Microphone {
    /// Opens the default input device on a worker thread.
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let waveform = Arc::new(Waveform::new());
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(String, u32), String>>();

        let thread_stop = stop.clone();
        let join = thread::Builder::new()
            .name("viicell-microphone".into())
            .spawn(move || run(app, waveform, thread_stop, ready_tx))
            .map_err(|err| format!("failed to spawn the microphone thread: {err}"))?;

        match ready_rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok((device, sample_rate))) => Ok(Self {
                stop,
                join: Some(join),
                device: Some(device),
                sample_rate: Some(sample_rate),
            }),
            Ok(Err(err)) => {
                let _ = join.join();
                Err(err)
            }
            Err(_) => {
                stop.store(true, Ordering::Relaxed);
                Err("timed out while opening the microphone".to_string())
            }
        }
    }

    pub fn status(&self) -> MicrophoneStatus {
        MicrophoneStatus {
            running: true,
            device: self.device.clone(),
            sample_rate: self.sample_rate,
            error: None,
        }
    }
}

impl Drop for Microphone {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn run(
    app: AppHandle,
    waveform: Arc<Waveform>,
    stop: Arc<AtomicBool>,
    ready: Sender<Result<(String, u32), String>>,
) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = ready.send(Err("no microphone found".to_string()));
        return;
    };
    let device_name = device.to_string();

    let config = match device.default_input_config() {
        Ok(config) => config,
        Err(err) => {
            let _ = ready.send(Err(format!("cannot read the microphone format: {err}")));
            return;
        }
    };
    let sample_rate = config.sample_rate();
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let stream_config: StreamConfig = config.into();

    let stream = match format {
        SampleFormat::I8 => build::<i8>(&device, &stream_config, channels, &waveform),
        SampleFormat::I16 => build::<i16>(&device, &stream_config, channels, &waveform),
        SampleFormat::I32 => build::<i32>(&device, &stream_config, channels, &waveform),
        SampleFormat::U8 => build::<u8>(&device, &stream_config, channels, &waveform),
        SampleFormat::U16 => build::<u16>(&device, &stream_config, channels, &waveform),
        SampleFormat::U32 => build::<u32>(&device, &stream_config, channels, &waveform),
        SampleFormat::F32 => build::<f32>(&device, &stream_config, channels, &waveform),
        SampleFormat::F64 => build::<f64>(&device, &stream_config, channels, &waveform),
        other => Err(format!("unsupported microphone sample format: {other}")),
    };

    let stream = match stream {
        Ok(stream) => stream,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };
    if let Err(err) = stream.play() {
        let _ = ready.send(Err(format!("cannot start the microphone: {err}")));
        return;
    }

    let _ = ready.send(Ok((device_name, sample_rate)));

    let mut buffer = [128u8; POINTS];
    let mut last_version = 0;
    while !stop.load(Ordering::Relaxed) {
        let version = waveform.snapshot(&mut buffer);
        if version != last_version {
            last_version = version;
            let _ = app.emit(WAVE_EVENT, buffer.to_vec());
        }
        thread::sleep(EMIT_INTERVAL);
    }
    drop(stream);
}

fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    waveform: &Arc<Waveform>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let waveform = waveform.clone();
    let mut window: Vec<f32> = Vec::with_capacity(WINDOW);
    let mut folded = [128u8; POINTS];

    device
        .build_input_stream(
            config.clone(),
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                for frame in data.chunks(channels) {
                    let Some(sample) = frame.first() else {
                        continue;
                    };
                    window.push(f32::from_sample(*sample));

                    if window.len() >= WINDOW {
                        fold(&window, &mut folded);
                        waveform.publish(&folded);
                        window.clear();
                    }
                }
            },
            |err| eprintln!("viicell-face: microphone stream error: {err}"),
            None,
        )
        .map_err(|err| format!("cannot open the microphone: {err}"))
}

/// Reduces a sample window to `POINTS` values, 128 being silence.
fn fold(window: &[f32], out: &mut [u8; POINTS]) {
    let stride = (window.len() / POINTS).max(1);
    for (index, slot) in out.iter_mut().enumerate() {
        let sample = window
            .get(index * stride)
            .copied()
            .unwrap_or(0.0)
            .clamp(-1.0, 1.0);
        *slot = ((sample + 1.0) * 127.5).round() as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_silence_to_the_midpoint() {
        let mut out = [0u8; POINTS];
        fold(&[0.0; WINDOW], &mut out);

        assert!(out.iter().all(|&value| value == 128));
    }

    #[test]
    fn folds_full_scale_to_the_ends() {
        let mut window = vec![0.0; WINDOW];
        // The folding stride is WINDOW / POINTS, so these are the first two
        // samples that reach the output.
        window[0] = 1.0;
        window[WINDOW / POINTS] = -1.0;

        let mut out = [0u8; POINTS];
        fold(&window, &mut out);

        assert_eq!(out[0], 255);
        assert_eq!(out[1], 0);
        assert!(out[2..].iter().all(|&value| value == 128), "{out:?}");
    }
}
