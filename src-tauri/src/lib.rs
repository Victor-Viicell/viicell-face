mod face_camera;
mod input;
mod microphone;
mod pointer;
mod ticker;
mod virtual_camera;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use face_camera::{FaceCamera, FaceCameraInfo, FaceCameraStatus};
use input::GlobalInput;
use microphone::{Microphone, MicrophoneStatus};
use tauri::ipc::InvokeBody;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use ticker::Ticker;
use virtual_camera::{Camera, CameraInfo, CameraStatus, DeviceInfo};

const MAIN_WINDOW: &str = "main";

#[derive(Default)]
struct AppState {
    camera: Mutex<Option<Camera>>,
    /// The webcam the facial-tracking mode reads; only open while that mode is
    /// on, so other apps keep the camera the rest of the time.
    face_camera: Mutex<Option<FaceCamera>>,
    microphone: Mutex<Option<Microphone>>,
    microphone_error: Mutex<Option<String>>,
}

/// Whether the tray icon could be created. Closing the window only hides it
/// when there is a tray icon to bring it back from.
#[derive(Default)]
struct TrayGuard(AtomicBool);

#[tauri::command]
fn list_video_devices() -> Vec<DeviceInfo> {
    virtual_camera::list_devices()
}

/// Claims a loopback device and starts streaming into it.
///
/// Restarts the stream if a camera is already running with a different size.
#[tauri::command]
fn start_camera(
    state: State<'_, AppState>,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<CameraInfo, String> {
    let mut slot = state
        .camera
        .lock()
        .map_err(|_| "camera state is poisoned".to_string())?;

    if let Some(running) = slot.as_ref() {
        let info = running.info();
        if info.width == width
            && info.height == height
            && info.fps == fps
            && running.status().running
        {
            return Ok(info.clone());
        }
    }

    // Dropping the previous camera stops its writer thread first.
    *slot = None;
    let camera = Camera::start(width, height, fps)?;
    let info = camera.info().clone();
    *slot = Some(camera);
    Ok(info)
}

#[tauri::command]
fn stop_camera(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state
        .camera
        .lock()
        .map_err(|_| "camera state is poisoned".to_string())?;
    *slot = None;
    Ok(())
}

#[tauri::command]
fn camera_status(state: State<'_, AppState>) -> CameraStatus {
    match state.camera.lock() {
        Ok(slot) => slot
            .as_ref()
            .map(Camera::status)
            .unwrap_or_else(|| CameraStatus::idle(None)),
        Err(_) => CameraStatus::idle(Some("camera state is poisoned".to_string())),
    }
}

/// Opens the tracking camera. Already running returns the same handle.
#[tauri::command]
fn start_face_camera(state: State<'_, AppState>) -> Result<FaceCameraInfo, String> {
    let mut slot = state
        .face_camera
        .lock()
        .map_err(|_| "face camera state is poisoned".to_string())?;

    if let Some(running) = slot.as_ref() {
        let status = running.status();
        if status.running {
            if let Some(info) = status.info {
                return Ok(info);
            }
        }
    }

    *slot = None;
    let camera = FaceCamera::start()?;
    let info = camera
        .status()
        .info
        .ok_or_else(|| "the face camera reported no device".to_string())?;
    *slot = Some(camera);
    Ok(info)
}

/// Releases the tracking camera (blocking for at most one device poll).
#[tauri::command]
fn stop_face_camera(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state
        .face_camera
        .lock()
        .map_err(|_| "face camera state is poisoned".to_string())?;
    *slot = None;
    Ok(())
}

#[tauri::command]
fn face_camera_status(state: State<'_, AppState>) -> FaceCameraStatus {
    match state.face_camera.lock() {
        Ok(slot) => slot
            .as_ref()
            .map(FaceCamera::status)
            .unwrap_or_else(|| FaceCameraStatus::idle(None)),
        Err(_) => FaceCameraStatus::idle(Some("face camera state is poisoned".to_string())),
    }
}

/// Hands the newest camera frame to the webview as a raw JPEG body.
///
/// An empty body means no frame has arrived yet. The raw response avoids both
/// the JSON size blow-up of a byte array and the cost of base64.
#[tauri::command]
fn face_frame(state: State<'_, AppState>) -> tauri::ipc::Response {
    let frame = state
        .face_camera
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(FaceCamera::frame))
        .unwrap_or_default();
    tauri::ipc::Response::new(frame)
}

/// The mode the window should start in, so `VIICELL_MODE=track` can open the
/// app already tracking (`manual` is the default).
#[tauri::command]
fn startup_mode() -> Option<String> {
    std::env::var("VIICELL_MODE").ok()
}

/// Sets how many frame ticks per second the webview renders on.
#[tauri::command]
fn set_tick_rate(ticker: State<'_, Ticker>, fps: u32) {
    ticker.set_rate(fps);
}

/// Whether the backend reads the input devices directly, which is what makes
/// the controls work while another window has focus.
#[tauri::command]
fn input_global(input: State<'_, GlobalInput>) -> bool {
    input.available()
}

#[tauri::command]
fn microphone_status(state: State<'_, AppState>) -> MicrophoneStatus {
    if let Ok(slot) = state.microphone.lock() {
        if let Some(microphone) = slot.as_ref() {
            return microphone.status();
        }
    }

    let error = state
        .microphone_error
        .lock()
        .ok()
        .and_then(|reason| reason.clone());
    MicrophoneStatus::inactive(error)
}

/// Receives one RGBA frame from the canvas.
///
/// The payload is a raw octet-stream body (the webview passes a `Uint8Array`
/// to `invoke`), so no JSON/base64 encoding is involved.
#[tauri::command]
fn push_frame(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("push_frame expects the frame as a raw RGBA byte body".to_string());
    };

    if let Ok(slot) = state.camera.lock() {
        if let Some(camera) = slot.as_ref() {
            camera.push(frame);
        }
    }

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn quit(app: &AppHandle) {
    // Release the virtual camera before the process goes away.
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut slot) = state.camera.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = state.face_camera.lock() {
            *slot = None;
        }
    }
    app.exit(0);
}

/// Adds the tray icon: left click (where supported) reopens the window, the
/// menu offers the same action plus quitting.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open viicell-face", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit viicell-face", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("viicell-face")
        .menu(&menu)
        // Ignored on Linux, where the tray host opens the menu on every click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    app.state::<TrayGuard>().0.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(TrayGuard::default())
        .invoke_handler(tauri::generate_handler![
            list_video_devices,
            start_camera,
            stop_camera,
            camera_status,
            start_face_camera,
            stop_face_camera,
            face_camera_status,
            face_frame,
            startup_mode,
            microphone_status,
            input_global,
            set_tick_rate,
            push_frame
        ])
        .setup(|app| {
            // Cursor tracking for the eyes: sampled here because Wayland hides
            // the pointer from the webview.
            pointer::start(app.handle().clone());

            // Reads the keyboard and wheel even when the window is not focused.
            // Without access to the devices it stays idle and the controls fall
            // back to the window's own key events.
            app.manage(GlobalInput::start(app.handle().clone()));

            // Frame timing for the canvas; the frontend sets the real rate once
            // it knows the output config.
            app.manage(Ticker::start(app.handle().clone(), 30));

            if let Err(err) = setup_tray(app) {
                eprintln!("viicell-face: tray icon unavailable: {err}");
            }

            // The synth mouth follows the microphone; without one the mouth
            // just draws its resting band.
            match Microphone::start(app.handle().clone()) {
                Ok(microphone) => {
                    let state = app.state::<AppState>();
                    if let Ok(mut slot) = state.microphone.lock() {
                        *slot = Some(microphone);
                    }
                }
                Err(err) => {
                    eprintln!("viicell-face: microphone unavailable: {err}");
                    if let Ok(mut slot) = app.state::<AppState>().microphone_error.lock() {
                        *slot = Some(err);
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let has_tray = window
                    .app_handle()
                    .try_state::<TrayGuard>()
                    .map(|guard| guard.0.load(Ordering::Relaxed))
                    .unwrap_or(false);

                if has_tray {
                    // Keep broadcasting from the tray instead of exiting.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
