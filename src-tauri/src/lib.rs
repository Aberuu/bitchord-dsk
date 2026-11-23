mod auth_windows;
mod commands;
mod tray;

use core_auth::{SecretVault, SpotifyService, YouTubeAuthService};
use core_downloads::LibraryStore;
use core_integrations::{DiscordService, ScrobbleService, SmtcController};
use core_lyrics::LyricsProxy;
use core_playback::NativeAudioEngine;
use core_stats::ListeningStatsStore;
use core_youtube::LoopbackProxy;
use parking_lot::Mutex;
use serde_json::json;
use std::sync::Arc;
use tauri::{Emitter, Manager, WindowEvent};
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub vault: Arc<SecretVault>,
    pub yt_auth: Arc<YouTubeAuthService>,
    pub spotify: Arc<SpotifyService>,
    pub lyrics: Arc<LyricsProxy>,
    pub proxy: Arc<LoopbackProxy>,
    pub discord: Arc<DiscordService>,
    pub scrobble: Arc<ScrobbleService>,
    pub library: Arc<LibraryStore>,
    pub stats: Arc<ListeningStatsStore>,
    pub playback: Arc<NativeAudioEngine>,
    pub smtc: Mutex<Option<SmtcController>>,
    pub vibrancy_mode: Mutex<String>,
    pub minimize_to_tray: Mutex<bool>,
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36")
        .build()
        .expect("build reqwest client");

    let vault = Arc::new(SecretVault::open_default().expect("open secret vault"));
    let yt_auth = Arc::new(YouTubeAuthService::new(Arc::clone(&vault), http.clone()));
    let spotify = Arc::new(SpotifyService::new(Arc::clone(&vault), http.clone()));
    let lyrics = Arc::new(LyricsProxy::new(http.clone()));
    let scrobble = Arc::new(ScrobbleService::new(Arc::clone(&vault), http.clone()));
    let library = Arc::new(LibraryStore::open_default(http.clone()).expect("open library database"));
    let stats = Arc::new(ListeningStatsStore::open_default().expect("open listening stats store"));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::reveal_main_window(app);
        }));

    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(move |app| {
            let proxy = tauri::async_runtime::block_on(LoopbackProxy::start(http.clone()))
                .expect("start loopback HTTP proxy");

            let app_handle_discord = app.handle().clone();
            let discord = Arc::new(DiscordService::new(
                Arc::clone(&vault),
                http.clone(),
                Arc::new(move |state| {
                    let _ = app_handle_discord.emit(
                        "bridge://event",
                        json!({ "event": "discord.state", "data": state }),
                    );
                }),
            ));

            let app_handle_audio = app.handle().clone();
            let playback = Arc::new(NativeAudioEngine::new(Arc::new(move |track_id| {
                let _ = app_handle_audio.emit(
                    "audio://track-ended",
                    json!({ "trackId": track_id }),
                );
            })));

            let mut vibrancy = "none".to_string();
            let mut smtc_ctrl: Option<SmtcController> = None;

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    if window_vibrancy::apply_mica(&window, None).is_ok() {
                        vibrancy = "mica".to_string();
                    } else if window_vibrancy::apply_acrylic(&window, Some((0, 0, 0, 235))).is_ok() {
                        vibrancy = "acrylic".to_string();
                    }
                    if let Ok(hwnd) = window.hwnd() {
                        let smtc_handle = app.handle().clone();
                        smtc_ctrl = Some(SmtcController::attach(hwnd.0 as usize, move |ev| {
                            let _ = smtc_handle.emit("desktop://media-action", ev);
                        }));
                    }
                }
            }

            let state = AppState {
                vault: Arc::clone(&vault),
                yt_auth: Arc::clone(&yt_auth),
                spotify: Arc::clone(&spotify),
                lyrics: Arc::clone(&lyrics),
                proxy: Arc::new(proxy),
                discord,
                scrobble: Arc::clone(&scrobble),
                library: Arc::clone(&library),
                stats: Arc::clone(&stats),
                playback,
                smtc: Mutex::new(smtc_ctrl),
                vibrancy_mode: Mutex::new(vibrancy),
                minimize_to_tray: Mutex::new(true),
            };
            app.manage(state);

            if let Err(err) = tray::setup_tray(app.handle()) {
                tracing::warn!("System tray setup failed: {err}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let state = window.state::<AppState>();
                    if *state.minimize_to_tray.lock() {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        let _ = state.stats.flush();
                        state.discord.shutdown();
                        state.playback.stop();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_desktop_bootstrap,
            commands::set_minimize_to_tray,
            commands::bridge_call,
            commands::open_yt_sign_in,
            commands::sign_out_yt,
            commands::smtc_update_metadata,
            commands::smtc_update_playback,
            commands::scrobble_get_state,
            commands::scrobble_update_config,
            commands::scrobble_disconnect_lastfm,
            commands::scrobble_lastfm_start,
            commands::scrobble_lastfm_finish,
            commands::scrobble_now_playing,
            commands::scrobble_submit,
            commands::downloads_list,
            commands::downloads_start,
            commands::downloads_delete,
            commands::downloads_media_url,
            commands::local_list_folders,
            commands::local_add_folder,
            commands::local_remove_folder,
            commands::local_scan,
            commands::local_list_tracks,
            commands::local_media_url,
            commands::audio_list_devices,
            commands::audio_snapshot,
            commands::audio_update_settings,
            commands::audio_play_file,
            commands::audio_queue_gapless_next,
            commands::audio_pause,
            commands::audio_resume,
            commands::audio_stop,
            commands::audio_seek,
            commands::audio_set_volume,
            commands::stats_record_sample,
            commands::stats_flush,
            commands::stats_get_summary,
            commands::stats_export_backup,
            commands::stats_import_backup,
            commands::replay_save_file,
            commands::check_for_updates,
            commands::open_devtools_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BitChord Desktop");
}
