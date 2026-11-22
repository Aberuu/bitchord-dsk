use serde::{Deserialize, Serialize};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtcMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtcPlayback {
    pub status: String,
    pub position_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtcEventPayload {
    pub action: String,
    pub position_ms: Option<u64>,
}

enum SmtcCommand {
    SetMetadata(SmtcMetadata),
    SetPlayback(SmtcPlayback),
}

pub struct SmtcController {
    tx: Option<Sender<SmtcCommand>>,
}

impl SmtcController {
    #[cfg(windows)]
    pub fn attach<F>(hwnd: usize, on_event: F) -> Self
    where
        F: Fn(SmtcEventPayload) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<SmtcCommand>();
        // Dedicated thread owns the WinRT SMTC controller so callers never block the UI thread.
        std::thread::Builder::new()
            .name("bitchord-smtc".into())
            .spawn(move || {
                use souvlaki::{
                    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
                    PlatformConfig,
                };

                let config = PlatformConfig {
                    dbus_name: "bitchord",
                    display_name: "BitChord",
                    hwnd: Some(hwnd as *mut std::ffi::c_void),
                };
                let Ok(mut controls) = MediaControls::new(config) else {
                    tracing::warn!("Failed to initialize Windows SMTC controls");
                    return;
                };

                let attach_res = controls.attach(move |event| {
                    let payload = match event {
                        MediaControlEvent::Play => Some(SmtcEventPayload {
                            action: "play".into(),
                            position_ms: None,
                        }),
                        MediaControlEvent::Pause => Some(SmtcEventPayload {
                            action: "pause".into(),
                            position_ms: None,
                        }),
                        MediaControlEvent::Toggle => Some(SmtcEventPayload {
                            action: "toggle".into(),
                            position_ms: None,
                        }),
                        MediaControlEvent::Next => Some(SmtcEventPayload {
                            action: "next".into(),
                            position_ms: None,
                        }),
                        MediaControlEvent::Previous => Some(SmtcEventPayload {
                            action: "previous".into(),
                            position_ms: None,
                        }),
                        MediaControlEvent::Stop => Some(SmtcEventPayload {
                            action: "stop".into(),
                            position_ms: None,
                        }),
                        MediaControlEvent::SetPosition(MediaPosition(dur)) => {
                            Some(SmtcEventPayload {
                                action: "seek".into(),
                                position_ms: Some(dur.as_millis() as u64),
                            })
                        }
                        _ => None,
                    };
                    if let Some(p) = payload {
                        on_event(p);
                    }
                });
                if let Err(err) = attach_res {
                    tracing::warn!("Failed to attach SMTC event listener: {err:?}");
                }

                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        SmtcCommand::SetMetadata(meta) => {
                            let _ = controls.set_metadata(MediaMetadata {
                                title: Some(meta.title.as_str()),
                                artist: meta.artist.as_deref(),
                                album: meta.album.as_deref(),
                                cover_url: meta.cover_url.as_deref(),
                                duration: meta.duration_ms.map(Duration::from_millis),
                            });
                        }
                        SmtcCommand::SetPlayback(pb) => {
                            let progress = pb
                                .position_ms
                                .map(|ms| MediaPosition(Duration::from_millis(ms)));
                            let state = match pb.status.as_str() {
                                "playing" => MediaPlayback::Playing { progress },
                                "paused" | "buffering" | "loading" => {
                                    MediaPlayback::Paused { progress }
                                }
                                _ => MediaPlayback::Stopped,
                            };
                            let _ = controls.set_playback(state);
                        }
                    }
                }
            })
            .ok();

        Self { tx: Some(tx) }
    }

    #[cfg(not(windows))]
    pub fn attach<F>(_hwnd: usize, _on_event: F) -> Self
    where
        F: Fn(SmtcEventPayload) + Send + 'static,
    {
        Self { tx: None }
    }

    pub fn update_metadata(&self, metadata: SmtcMetadata) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(SmtcCommand::SetMetadata(metadata));
        }
    }

    pub fn update_playback(&self, playback: SmtcPlayback) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(SmtcCommand::SetPlayback(playback));
        }
    }
}
