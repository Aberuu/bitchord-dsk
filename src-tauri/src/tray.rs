use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub const TRAY_ID: &str = "bitchord-tray";

pub fn sync_tray(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    if !enabled {
        let _ = app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    setup_tray(app)
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let play_pause = MenuItem::with_id(app, "tray_toggle", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "tray_next", "Next Track", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "tray_prev", "Previous Track", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "tray_show", "Show BitChord", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit BitChord", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&play_pause, &next, &prev, &sep1, &show, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("BitChord")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_toggle" => {
                let _ = app.emit("desktop://media-action", serde_json::json!({ "action": "toggle" }));
            }
            "tray_next" => {
                let _ = app.emit("desktop://media-action", serde_json::json!({ "action": "next" }));
            }
            "tray_prev" => {
                let _ = app.emit("desktop://media-action", serde_json::json!({ "action": "previous" }));
            }
            "tray_show" => reveal_main_window(app),
            "tray_quit" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::shutdown_and_exit(&handle).await;
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn reveal_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
