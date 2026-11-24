mod auth_windows;
mod commands;
mod tray;

use core_auth::{DesktopPrefs, SecretVault, SpotifyService, YouTubeAuthService};
use core_downloads::LibraryStore;
use core_integrations::{CastService, DiscordService, ScrobbleService, SmtcController};
use core_lyrics::LyricsProxy;
use core_playback::{AudioHotplugWatcher, AudioTapServer, NativeAudioEngine};
use core_sources::SourcesService;
use core_stats::ListeningStatsStore;
use core_youtube::LoopbackProxy;
use parking_lot::Mutex;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tracing_subscriber::EnvFilter;

pub struct AppState {
    pub vault: Arc<SecretVault>,
    pub yt_auth: Arc<YouTubeAuthService>,
    pub spotify: Arc<SpotifyService>,
    pub lyrics: Arc<LyricsProxy>,
    pub proxy: Arc<LoopbackProxy>,
    pub sources: Arc<SourcesService>,
    pub discord: Arc<DiscordService>,
    pub scrobble: Arc<ScrobbleService>,
    pub library: Arc<LibraryStore>,
    pub stats: Arc<ListeningStatsStore>,
    pub playback: Arc<NativeAudioEngine>,
    pub cast: Arc<CastService>,
    pub audio_tap_url: String,
    pub _audio_hotplug: AudioHotplugWatcher,
    pub smtc: Mutex<Option<SmtcController>>,
    pub vibrancy_mode: Mutex<String>,
    pub minimize_to_tray: Mutex<bool>,
    pub prefs_path: PathBuf,
}

pub async fn shutdown_and_exit(app: &AppHandle) {
    let _ = app.remove_tray_by_id(tray::TRAY_ID);
    if let Some(state) = app.try_state::<AppState>() {
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(1200),
            state.cast.disconnect(),
        )
        .await;
        let _ = state.stats.flush();
        state.discord.shutdown();
        state.playback.stop();
    }
    app.exit(0);
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let wm = core_auth::watermark::verify_embedded_watermark();
    if !wm.integrity_valid {
        tracing::warn!("Embedded attribution watermark integrity check failed");
    } else {
        tracing::debug!("Verified attribution watermark for {}", wm.author);
    }

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36")
        .build()
        .expect("build reqwest client");

    let vault = Arc::new(SecretVault::open_default().expect("open secret vault"));
    let yt_auth = Arc::new(YouTubeAuthService::new(Arc::clone(&vault), http.clone()));
    let spotify = Arc::new(SpotifyService::new(Arc::clone(&vault), http.clone()));
    let lyrics = Arc::new(LyricsProxy::new(http.clone()));
    let sources = Arc::new(SourcesService::new(Arc::clone(&vault), http.clone()));
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
            let smb_sources = Arc::clone(&sources);
            proxy.set_smb_reader(Arc::new(move |rel_path, start, end| {
                let svc = Arc::clone(&smb_sources);
                Box::pin(async move {
                    let cfg = svc
                        .smb_config()
                        .ok_or_else(|| anyhow::anyhow!("SMB is not configured"))?;
                    core_sources::smb::read_smb_range(&cfg, &rel_path, start, end).await
                })
            }));

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

            let app_handle_cast_state = app.handle().clone();
            let app_handle_cast_end = app.handle().clone();
            let cast = Arc::new(CastService::new(
                http.clone(),
                Arc::new(move |cast_state| {
                    let _ = app_handle_cast_state.emit("cast://state", cast_state);
                }),
                Arc::new(move |track_id| {
                    let _ = app_handle_cast_end.emit(
                        "cast://track-ended",
                        json!({ "trackId": track_id }),
                    );
                }),
            ));

            let (desktop_prefs, prefs_path) = DesktopPrefs::load_default();
            let initial_tray = desktop_prefs.minimize_to_tray;

            let tap_server = tauri::async_runtime::block_on(AudioTapServer::start(playback.tap_buffer()))
                .expect("start loopback audio tap server");
            let audio_tap_url = tap_server.ws_url().to_string();

            let playback_hotplug = Arc::clone(&playback);
            let app_handle_hotplug = app.handle().clone();
            let audio_hotplug = AudioHotplugWatcher::start(Arc::new(move || {
                playback_hotplug.handle_devices_changed();
                let _ = app_handle_hotplug.emit("audio://devices-changed", json!({}));
            }));

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
                sources: Arc::clone(&sources),
                discord,
                scrobble: Arc::clone(&scrobble),
                library: Arc::clone(&library),
                stats: Arc::clone(&stats),
                playback,
                cast,
                audio_tap_url,
                _audio_hotplug: audio_hotplug,
                smtc: Mutex::new(smtc_ctrl),
                vibrancy_mode: Mutex::new(vibrancy),
                minimize_to_tray: Mutex::new(initial_tray),
                prefs_path,
            };
            app.manage(state);

            if let Err(err) = tray::sync_tray(app.handle(), initial_tray) {
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
                        api.prevent_close();
                        let _ = window.hide();
                        let handle = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            shutdown_and_exit(&handle).await;
                        });
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
            commands::audio_start_tap,
            commands::audio_stop_tap,
            commands::audio_flush_tap,
            commands::audio_probe_asio_driver,
            commands::audio_open_asio_control_panel,
            commands::cast_support_status,
            commands::cast_get_state,
            commands::cast_discover,
            commands::cast_load_media,
            commands::cast_play,
            commands::cast_pause,
            commands::cast_seek,
            commands::cast_set_volume,
            commands::cast_disconnect,
            commands::stats_record_sample,
            commands::stats_flush,
            commands::stats_get_summary,
            commands::stats_export_backup,
            commands::stats_import_backup,
            commands::replay_save_file,
            commands::check_for_updates,
            commands::get_watermark_status,
            commands::open_devtools_window,
            commands::sources_get_state,
            commands::sources_set_addons,
            commands::sources_set_jiosaavn,
            commands::sources_set_tolerance,
            commands::sources_identify_addon,
            commands::sources_probe_addon,
            commands::sources_search_source,
            commands::sources_resolve_candidate,
            commands::webdav_test,
            commands::webdav_save,
            commands::webdav_disconnect,
            commands::webdav_list_tracks,
            commands::smb_test,
            commands::smb_save,
            commands::smb_disconnect,
            commands::smb_list_tracks,
            commands::audio_play_remote_source,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BitChord Desktop");
}
