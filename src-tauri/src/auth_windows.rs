use crate::AppState;
use anyhow::Result;
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const YT_SIGNIN_URL: &str =
    "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";
const SPOTIFY_SIGNIN_URL: &str =
    "https://accounts.spotify.com/en/login?continue=https%3A%2F%2Fopen.spotify.com%2F";
const DISCORD_SIGNIN_URL: &str = "https://discord.com/login";
const CHROME_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const DISCORD_TOKEN_CAPTURE_JS: &str = r#"
(() => {
  if (window.__bcDiscordPoll) return;
  window.__bcDiscordPoll = setInterval(() => {
    try {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      document.documentElement.appendChild(f);
      const raw = f.contentWindow && f.contentWindow.localStorage ? f.contentWindow.localStorage.getItem('token') : null;
      f.remove();
      if (raw && raw.length > 20) {
        const clean = raw.replace(/^"+|"+$/g, '');
        if (clean.length > 20) {
          clearInterval(window.__bcDiscordPoll);
          document.title = '__BC_DISCORD_TOKEN__:' + clean;
        }
      }
    } catch (_) {}
  }, 1000);
})();
"#;

pub fn open_youtube_login(app: &AppHandle) -> Result<()> {
    if let Some(existing) = app.get_webview_window("auth-youtube") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = Url::parse(YT_SIGNIN_URL)?;
    let handle = app.clone();
    // Build the child WebView2 window on a worker thread so synchronous IPC calls never deadlock the Win32 UI pump.
    std::thread::spawn(move || {
        let window = match WebviewWindowBuilder::new(&handle, "auth-youtube", WebviewUrl::External(url))
            .title("Sign in to YouTube Music")
            .user_agent(CHROME_USER_AGENT)
            .inner_size(520.0, 720.0)
            .visible(true)
            .focused(true)
            .center()
            .build()
        {
            Ok(w) => w,
            Err(err) => {
                tracing::error!("Failed to build YouTube login window: {err}");
                return;
            }
        };

        tauri::async_runtime::spawn(async move {
            let music_url = Url::parse("https://music.youtube.com/").unwrap();
            for _ in 0..300 {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                let Some(win) = handle.get_webview_window("auth-youtube") else {
                    return;
                };
                let on_music = win
                    .url()
                    .ok()
                    .and_then(|u| u.host_str().map(|h| h == "music.youtube.com"))
                    .unwrap_or(false);
                if !on_music {
                    continue;
                }
                if let Ok(cookies) = win.cookies_for_url(music_url.clone()) {
                    let has_sapisid = cookies.iter().any(|c| {
                        matches!(
                            c.name(),
                            "SAPISID" | "__Secure-3PAPISID" | "__Secure-1PAPISID"
                        ) && !c.value().is_empty()
                    });
                    if has_sapisid {
                        let header = cookies
                            .iter()
                            .map(|c| format!("{}={}", c.name(), c.value()))
                            .collect::<Vec<_>>()
                            .join("; ");
                        let state = handle.state::<AppState>();
                        if state.yt_auth.save_cookies(Some(header)).is_ok() {
                            let auth = state.yt_auth.auth_state(true).await;
                            let _ = handle.emit(
                                "bridge://event",
                                json!({ "event": "yt.authState", "data": auth }),
                            );
                        }
                        let _ = win.close();
                        return;
                    }
                }
            }
            let _ = window.close();
        });
    });
    Ok(())
}

pub fn open_spotify_login(app: &AppHandle) -> Result<()> {
    if let Some(existing) = app.get_webview_window("auth-spotify") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = Url::parse(SPOTIFY_SIGNIN_URL)?;
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = WebviewWindowBuilder::new(&handle, "auth-spotify", WebviewUrl::External(url))
            .title("Sign in to Spotify")
            .user_agent(CHROME_USER_AGENT)
            .inner_size(520.0, 720.0)
            .visible(true)
            .focused(true)
            .center()
            .build()
        {
            tracing::error!("Failed to build Spotify login window: {err}");
            return;
        }

        tauri::async_runtime::spawn(async move {
            let open_url = Url::parse("https://open.spotify.com/").unwrap();
            for _ in 0..300 {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                let Some(win) = handle.get_webview_window("auth-spotify") else {
                    return;
                };
                if let Ok(cookies) = win.cookies_for_url(open_url.clone()) {
                    if let Some(sp_dc) = cookies
                        .iter()
                        .find(|c| c.name() == "sp_dc" && !c.value().is_empty())
                    {
                        let val = sp_dc.value().to_string();
                        let state = handle.state::<AppState>();
                        if state.spotify.save_sp_dc(Some(val)).is_ok() {
                            let auth = state.spotify.auth_state(true).await;
                            let _ = handle.emit(
                                "bridge://event",
                                json!({ "event": "spotify.authState", "data": auth }),
                            );
                        }
                        let _ = win.close();
                        return;
                    }
                }
            }
        });
    });
    Ok(())
}

pub fn open_discord_login(app: &AppHandle) -> Result<()> {
    if let Some(existing) = app.get_webview_window("auth-discord") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = Url::parse(DISCORD_SIGNIN_URL)?;
    let handle = app.clone();
    std::thread::spawn(move || {
        let h_for_title = handle.clone();
        // Read token through document title change so external discord.com never receives Tauri IPC access.
        if let Err(err) = WebviewWindowBuilder::new(&handle, "auth-discord", WebviewUrl::External(url))
            .title("Connect Discord")
            .user_agent(CHROME_USER_AGENT)
            .inner_size(520.0, 720.0)
            .visible(true)
            .focused(true)
            .center()
            .initialization_script(DISCORD_TOKEN_CAPTURE_JS)
            .on_document_title_changed(move |win, title| {
                if let Some(token) = title.strip_prefix("__BC_DISCORD_TOKEN__:") {
                    let token = token.to_string();
                    let h = h_for_title.clone();
                    let win_clone = win.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = h.state::<AppState>();
                        if let Err(err) = state.discord.connect_with_token(token).await {
                            tracing::warn!("Discord token validation failed: {err}");
                        }
                        let _ = win_clone.close();
                    });
                }
            })
            .build()
        {
            tracing::error!("Failed to build Discord login window: {err}");
        }
    });
    Ok(())
}
