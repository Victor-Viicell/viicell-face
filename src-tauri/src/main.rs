// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    prefer_compatible_wayland_rendering();
    viicell_face_lib::run()
}

/// WebKitGTK's DMA-BUF renderer can tear down the Wayland connection while the
/// window is being created on some driver/compositor combinations (NVIDIA on
/// Hyprland, for instance). The symptom is the process dying immediately with
/// `Gdk-Message: ... Error 71 (Protocol error) dispatching to Wayland display`.
///
/// WebKit's shared-memory fallback renders the webview (including WebGL) just
/// fine, so it is the safer default under Wayland. Set `VIICELL_DMABUF=1` to opt
/// back into the zero-copy path, or set `WEBKIT_DISABLE_DMABUF_RENDERER`
/// yourself — an explicit value always wins over this default.
fn prefer_compatible_wayland_rendering() {
    #[cfg(target_os = "linux")]
    {
        use std::env;

        let on_wayland = env::var_os("WAYLAND_DISPLAY").is_some()
            || env::var("XDG_SESSION_TYPE")
                .is_ok_and(|session| session.eq_ignore_ascii_case("wayland"));
        let already_configured = env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();
        let opted_in = env::var_os("VIICELL_DMABUF").is_some();

        if on_wayland && !already_configured && !opted_in {
            // SAFETY: this runs in `main` before the app creates any thread or
            // touches GTK/WebKit, so nothing else observes the environment yet.
            unsafe { env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }
    }
}
