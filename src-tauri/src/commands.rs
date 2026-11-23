use crate::auth_windows::{open_discord_login, open_spotify_login, open_youtube_login};
use crate::AppState;
use base64::Engine;
use core_auth::{app_data_dir, YtFetchParams};
use core_downloads::{DownloadRequest, DownloadedTrack, LocalTrack};
use core_integrations::{
    DiscordNowPlaying, DiscordPresenceOptions, LastFmTokenAuth, ScrobbleConfigUpdate,
    ScrobbleState, ScrobbleTrack, SmtcMetadata, SmtcPlayback,
};
use core_lyrics::HttpRequestParams;
use core_playback::{AudioDeviceInfo, AudioSettings, NativePlaybackSnapshot};
use core_stats::{
    save_file_bytes, BackupSummary, ListeningSampleInput, ReplayPeriod, ReplaySummary,
};
use directories::UserDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCallResult {
    pub ok: bool,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl BridgeCallResult {
    fn success(value: Value) -> Self {
        Self {
            ok: true,
            result: Some(value),
            error_code: None,
            error_message: None,
        }
    }

    fn failure(code: &str, msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error_code: Some(code.to_string()),
            error_message: Some(msg.into()),
        }
    }

    fn from_anyhow(err: anyhow::Error) -> Self {
        let msg = err.to_string();
        let code = if msg.starts_with("unauthenticated:") {
            "unauthenticated"
        } else if msg.starts_with("forbidden:") {
            "forbidden"
        } else {
            "network"
        };
        Self::failure(code, msg)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrap {
    pub proxy_base_url: String,
    pub audio_tap_url: String,
    pub vibrancy_mode: String,
    pub minimize_to_tray: bool,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub status: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub fn get_desktop_bootstrap(state: State<'_, AppState>) -> DesktopBootstrap {
    DesktopBootstrap {
        proxy_base_url: state.proxy.base_url().to_string(),
        audio_tap_url: state.audio_tap_url.clone(),
        vibrancy_mode: state.vibrancy_mode.lock().clone(),
        minimize_to_tray: *state.minimize_to_tray.lock(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
pub fn set_minimize_to_tray(enabled: bool, state: State<'_, AppState>) -> bool {
    *state.minimize_to_tray.lock() = enabled;
    enabled
}

#[tauri::command]
pub async fn bridge_call(
    method: String,
    params: Value,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BridgeCallResult, String> {
    let outcome = match method.as_str() {
        "ping" => BridgeCallResult::success(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": 1,
            "browser": "chromium",
            "capabilities": ["yt", "yt.auth", "yt.stats", "addon", "lyrics", "spotify", "discord"]
        })),
        "yt.fetch" => match serde_json::from_value::<YtFetchParams>(params) {
            Ok(req) => match state.yt_auth.yt_fetch(req).await {
                Ok(resp) => BridgeCallResult::success(serde_json::to_value(resp).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::from_anyhow(err),
            },
            Err(err) => BridgeCallResult::failure("protocol", err.to_string()),
        },
        "yt.authState" => {
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            let auth = state.yt_auth.auth_state(refresh).await;
            BridgeCallResult::success(serde_json::to_value(auth).unwrap_or(Value::Null))
        }
        "yt.selectChannel" => {
            let id = params.get("channelId").and_then(Value::as_str).unwrap_or("");
            match state.yt_auth.select_channel(id).await {
                Ok(auth) => {
                    let val = serde_json::to_value(&auth).unwrap_or(Value::Null);
                    let _ = app.emit("bridge://event", json!({ "event": "yt.authState", "data": val }));
                    BridgeCallResult::success(val)
                }
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "yt.setConnected" => {
            let connected = params.get("connected").and_then(Value::as_bool).unwrap_or(true);
            match state.yt_auth.set_connected(connected).await {
                Ok(auth) => {
                    let val = serde_json::to_value(&auth).unwrap_or(Value::Null);
                    let _ = app.emit("bridge://event", json!({ "event": "yt.authState", "data": val }));
                    BridgeCallResult::success(val)
                }
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "lyrics.fetch" => match serde_json::from_value::<HttpRequestParams>(params) {
            Ok(req) => match state.lyrics.fetch_lyrics(req).await {
                Ok(resp) => BridgeCallResult::success(serde_json::to_value(resp).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::from_anyhow(err),
            },
            Err(err) => BridgeCallResult::failure("protocol", err.to_string()),
        },
        "lyrics.permissions" => {
            let origins = params
                .get("origins")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            BridgeCallResult::success(json!({ "granted": origins }))
        }
        "lyrics.requestPermissions" => BridgeCallResult::success(json!({})),
        "addon.fetch" => match serde_json::from_value::<HttpRequestParams>(params) {
            Ok(req) => match state.lyrics.fetch_addon(req).await {
                Ok(resp) => BridgeCallResult::success(serde_json::to_value(resp).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::from_anyhow(err),
            },
            Err(err) => BridgeCallResult::failure("protocol", err.to_string()),
        },
        "spotify.authState" => {
            let refresh = params.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            let auth = state.spotify.auth_state(refresh).await;
            BridgeCallResult::success(serde_json::to_value(auth).unwrap_or(Value::Null))
        }
        "spotify.setConnected" => {
            let connected = params.get("connected").and_then(Value::as_bool).unwrap_or(true);
            match state.spotify.set_connected(connected).await {
                Ok(auth) => {
                    let val = serde_json::to_value(&auth).unwrap_or(Value::Null);
                    let _ = app.emit("bridge://event", json!({ "event": "spotify.authState", "data": val }));
                    BridgeCallResult::success(val)
                }
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "spotify.signIn" => match open_spotify_login(&app) {
            Ok(()) => BridgeCallResult::success(json!({})),
            Err(err) => BridgeCallResult::failure("internal", err.to_string()),
        },
        "spotify.playlists" => {
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
            match state.spotify.playlists(offset).await {
                Ok(page) => BridgeCallResult::success(serde_json::to_value(page).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "spotify.tracks" => {
            let pid = params.get("playlistId").and_then(Value::as_str).unwrap_or("");
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
            match state.spotify.tracks(pid, offset).await {
                Ok(page) => BridgeCallResult::success(serde_json::to_value(page).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "spotify.playlist" => {
            let pid = params.get("playlistId").and_then(Value::as_str).unwrap_or("");
            match state.spotify.playlist_info(pid).await {
                Ok(info) => BridgeCallResult::success(serde_json::to_value(info).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "spotify.searchTracks" => {
            let q = params.get("query").and_then(Value::as_str).unwrap_or("");
            match state.spotify.search_tracks(q).await {
                Ok(tracks) => BridgeCallResult::success(serde_json::to_value(tracks).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "spotify.canvas" => {
            let tid = params.get("trackId").and_then(Value::as_str).unwrap_or("");
            match state.spotify.canvas(tid).await {
                Ok(url) => BridgeCallResult::success(json!({ "url": url })),
                Err(err) => BridgeCallResult::from_anyhow(err),
            }
        }
        "discord.state" => {
            BridgeCallResult::success(serde_json::to_value(state.discord.state()).unwrap_or(Value::Null))
        }
        "discord.connect" => match open_discord_login(&app) {
            Ok(()) => BridgeCallResult::success(json!({})),
            Err(err) => BridgeCallResult::failure("internal", err.to_string()),
        },
        "discord.disconnect" => match state.discord.disconnect() {
            Ok(st) => BridgeCallResult::success(serde_json::to_value(st).unwrap_or(Value::Null)),
            Err(err) => BridgeCallResult::failure("internal", err.to_string()),
        },
        "discord.setEnabled" => {
            let on = params.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            match state.discord.set_enabled(on) {
                Ok(st) => BridgeCallResult::success(serde_json::to_value(st).unwrap_or(Value::Null)),
                Err(err) => BridgeCallResult::failure("internal", err.to_string()),
            }
        }
        "discord.presence" => {
            #[derive(Deserialize)]
            struct PresenceParams {
                track: Option<DiscordNowPlaying>,
                options: DiscordPresenceOptions,
            }
            match serde_json::from_value::<PresenceParams>(params) {
                Ok(p) => match state.discord.set_presence(p.track, p.options).await {
                    Ok(()) => BridgeCallResult::success(json!({})),
                    Err(err) => BridgeCallResult::from_anyhow(err),
                },
                Err(err) => BridgeCallResult::failure("protocol", err.to_string()),
            }
        }
        other => BridgeCallResult::failure("unsupported", format!("Unknown bridge method: {other}")),
    };
    Ok(outcome)
}

#[tauri::command]
pub async fn open_yt_sign_in(app: AppHandle) -> Result<(), String> {
    open_youtube_login(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sign_out_yt(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.yt_auth.sign_out().map_err(|e| e.to_string())?;
    let auth = state.yt_auth.auth_state(false).await;
    let _ = app.emit("bridge://event", json!({ "event": "yt.authState", "data": auth }));
    Ok(())
}

#[tauri::command]
pub fn smtc_update_metadata(meta: SmtcMetadata, state: State<'_, AppState>) {
    if let Some(smtc) = state.smtc.lock().as_ref() {
        smtc.update_metadata(meta);
    }
}

#[tauri::command]
pub fn smtc_update_playback(playback: SmtcPlayback, state: State<'_, AppState>) {
    if let Some(smtc) = state.smtc.lock().as_ref() {
        smtc.update_playback(playback);
    }
}

#[tauri::command]
pub fn scrobble_get_state(state: State<'_, AppState>) -> ScrobbleState {
    state.scrobble.state()
}

#[tauri::command]
pub fn scrobble_update_config(
    update: ScrobbleConfigUpdate,
    state: State<'_, AppState>,
) -> Result<ScrobbleState, String> {
    state.scrobble.update_config(update).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scrobble_disconnect_lastfm(state: State<'_, AppState>) -> Result<ScrobbleState, String> {
    state
        .scrobble
        .disconnect_lastfm()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scrobble_lastfm_start(state: State<'_, AppState>) -> Result<LastFmTokenAuth, String> {
    state
        .scrobble
        .lastfm_start_auth()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scrobble_lastfm_finish(
    token: String,
    state: State<'_, AppState>,
) -> Result<ScrobbleState, String> {
    state
        .scrobble
        .lastfm_finish_auth(&token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scrobble_now_playing(
    track: ScrobbleTrack,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.scrobble.update_now_playing(track).await;
    Ok(())
}

#[tauri::command]
pub async fn scrobble_submit(
    track: ScrobbleTrack,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.scrobble.scrobble(track).await;
    Ok(())
}

#[tauri::command]
pub fn downloads_list(state: State<'_, AppState>) -> Result<Vec<DownloadedTrack>, String> {
    state.library.list_downloads().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn downloads_start(
    req: DownloadRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DownloadedTrack, String> {
    let h = app.clone();
    state
        .library
        .download_track(req, move |progress| {
            let _ = h.emit("downloads://progress", progress);
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn downloads_delete(video_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .library
        .delete_download(&video_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn downloads_media_url(video_id: String, state: State<'_, AppState>) -> Option<String> {
    let path = state.library.get_download_path(&video_id)?;
    Some(state.proxy.register_local_file(format!("dl-{video_id}"), path))
}

#[tauri::command]
pub fn local_list_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state
        .library
        .list_local_folders()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_add_folder(folder: String, state: State<'_, AppState>) -> Result<Vec<LocalTrack>, String> {
    state
        .library
        .add_local_folder(folder)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_remove_folder(folder: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .library
        .remove_local_folder(&folder)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_scan(state: State<'_, AppState>) -> Result<Vec<LocalTrack>, String> {
    state
        .library
        .scan_local_folders()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_list_tracks(state: State<'_, AppState>) -> Result<Vec<LocalTrack>, String> {
    state
        .library
        .list_local_tracks()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_media_url(id: String, state: State<'_, AppState>) -> Option<String> {
    let path = state.library.get_local_track_path(&id)?;
    Some(state.proxy.register_local_file(id.replace(':', "-"), path))
}

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Audio background task failed: {e}"))
}

#[tauri::command]
pub async fn audio_list_devices(state: State<'_, AppState>) -> Result<Vec<AudioDeviceInfo>, String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.devices()).await
}

#[tauri::command]
pub async fn audio_snapshot(state: State<'_, AppState>) -> Result<NativePlaybackSnapshot, String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.snapshot()).await
}

#[tauri::command]
pub async fn audio_update_settings(
    settings: AudioSettings,
    state: State<'_, AppState>,
) -> Result<NativePlaybackSnapshot, String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.update_settings(settings)).await
}

#[tauri::command]
pub async fn audio_play_file(
    track_id: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<NativePlaybackSnapshot, String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.play_local_file(track_id, PathBuf::from(file_path)))
        .await?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn audio_queue_gapless_next(
    track_id: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.queue_gapless_next(track_id, PathBuf::from(file_path)))
        .await?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn audio_pause(state: State<'_, AppState>) {
    state.playback.pause();
}

#[tauri::command]
pub fn audio_resume(state: State<'_, AppState>) {
    state.playback.resume();
}

#[tauri::command]
pub async fn audio_stop(state: State<'_, AppState>) -> Result<(), String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.stop()).await
}

#[tauri::command]
pub fn audio_seek(seconds: f64, state: State<'_, AppState>) {
    state.playback.seek(seconds);
}

#[tauri::command]
pub fn audio_set_volume(volume: f32, muted: bool, state: State<'_, AppState>) {
    state.playback.set_volume(volume, muted);
}

#[tauri::command]
pub async fn audio_start_tap(state: State<'_, AppState>) -> Result<NativePlaybackSnapshot, String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.start_tap_mode())
        .await?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn audio_stop_tap(state: State<'_, AppState>) -> Result<NativePlaybackSnapshot, String> {
    let playback = state.playback.clone();
    run_blocking(move || playback.stop_tap_mode()).await
}

#[tauri::command]
pub fn audio_flush_tap(state: State<'_, AppState>) {
    state.playback.flush_tap();
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    #[cfg(feature = "updater")]
    {
        use tauri_plugin_updater::UpdaterExt;
        if let Ok(updater) = app.updater() {
            return match updater.check().await {
                Ok(Some(update)) => Ok(UpdateCheckResult {
                    status: "available".into(),
                    current_version: current,
                    latest_version: Some(update.version),
                    notes: update.body,
                }),
                Ok(None) => Ok(UpdateCheckResult {
                    status: "up_to_date".into(),
                    current_version: current,
                    latest_version: None,
                    notes: None,
                }),
                Err(err) => Ok(UpdateCheckResult {
                    status: "unconfigured".into(),
                    current_version: current,
                    latest_version: None,
                    notes: Some(err.to_string()),
                }),
            };
        }
    }
    let _ = app;
    Ok(UpdateCheckResult {
        status: "unconfigured".into(),
        current_version: current,
        latest_version: None,
        notes: Some(
            "Configure a signed GitHub Releases manifest URL and minisign public key, then build with --features updater."
                .into(),
        ),
    })
}

#[tauri::command]
pub fn stats_record_sample(
    sample: ListeningSampleInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let counts = sample.counts_as_play;
    state
        .stats
        .record_sample(sample)
        .map_err(|e| e.to_string())?;
    if counts {
        let _ = app.emit("stats://updated", json!({}));
    }
    Ok(())
}

#[tauri::command]
pub fn stats_flush(state: State<'_, AppState>) -> Result<(), String> {
    state.stats.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_get_summary(
    period: ReplayPeriod,
    state: State<'_, AppState>,
) -> Result<ReplaySummary, String> {
    state.stats.summary(period).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_export_backup(state: State<'_, AppState>) -> Result<String, String> {
    state.stats.export_backup_json().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_import_backup(
    raw_json: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BackupSummary, String> {
    let summary = state
        .stats
        .import_backup_json(&raw_json)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("stats://updated", json!({}));
    Ok(summary)
}

#[tauri::command]
pub fn replay_save_file(file_name: String, base64_bytes: String) -> Result<String, String> {
    let safe_name = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let target_dir = UserDirs::new()
        .and_then(|u| u.download_dir().map(PathBuf::from))
        .or_else(|| app_data_dir().ok())
        .ok_or_else(|| "Could not locate Downloads directory".to_string())?;
    let path = target_dir.join(if safe_name.is_empty() {
        "bitchord-export.bin".to_string()
    } else {
        safe_name
    });
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_bytes.trim())
        .map_err(|e| format!("Invalid export data: {e}"))?;
    save_file_bytes(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_watermark_status() -> Result<core_auth::watermark::EmbeddedWatermarkStatus, String> {
    let status = core_auth::watermark::verify_embedded_watermark();
    if status.integrity_valid {
        Ok(status)
    } else {
        Err("Embedded watermark integrity check failed".to_string())
    }
}

#[tauri::command]
pub fn open_devtools_window(app: AppHandle) {
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            w.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}
