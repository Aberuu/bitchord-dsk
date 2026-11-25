pub mod castv2;
pub mod discovery;
pub mod dlna;
pub mod probe;
pub mod relay;
pub mod types;

pub use probe::{open_windows_cast_flyout, open_windows_cast_settings};
pub use types::{
    CastDevice, CastLoadRequest, CastProtocol, CastSessionState, CastSupportStatus,
};

use anyhow::{anyhow, Result};
use castv2::{start_chromecast_session, ChromecastCmd, ChromecastMeta};
use discovery::discover_all_devices;
use dlna::{start_dlna_session, DlnaCmd, DlnaMeta};
use parking_lot::Mutex;
use probe::probe_cast_support;
use relay::CastMediaRelay;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;

enum ActiveHandle {
    Chromecast(mpsc::Sender<ChromecastCmd>),
    Dlna(mpsc::Sender<DlnaCmd>),
}

pub struct CastService {
    http: reqwest::Client,
    relay: CastMediaRelay,
    state: Arc<Mutex<CastSessionState>>,
    handle: Arc<Mutex<Option<(String, ActiveHandle)>>>,
    on_state: Arc<dyn Fn(CastSessionState) + Send + Sync>,
    on_track_ended: Arc<dyn Fn(String) + Send + Sync>,
}

impl CastService {
    pub fn new(
        http: reqwest::Client,
        on_state_cb: Arc<dyn Fn(CastSessionState) + Send + Sync>,
        on_track_ended_cb: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Self {
        let state = Arc::new(Mutex::new(CastSessionState::default()));
        let state_ref = Arc::clone(&state);
        let handle_ref: Arc<Mutex<Option<(String, ActiveHandle)>>> = Arc::new(Mutex::new(None));
        let handle_clear = Arc::clone(&handle_ref);

        let on_state = Arc::new(move |next: CastSessionState| {
            *state_ref.lock() = next.clone();
            if !next.connected {
                *handle_clear.lock() = None;
            }
            on_state_cb(next);
        });

        Self {
            http: http.clone(),
            relay: CastMediaRelay::new(http),
            state,
            handle: handle_ref,
            on_state,
            on_track_ended: on_track_ended_cb,
        }
    }

    pub fn support_status(&self) -> CastSupportStatus {
        probe_cast_support()
    }

    pub fn session_state(&self) -> CastSessionState {
        self.state.lock().clone()
    }

    pub async fn discover(&self, timeout_ms: Option<u64>) -> Vec<CastDevice> {
        discover_all_devices(&self.http, timeout_ms.unwrap_or(3000)).await
    }

    pub async fn load_media(&self, req: CastLoadRequest) -> Result<CastSessionState> {
        let local_path = req.local_file_path.as_ref().map(PathBuf::from);
        if local_path.is_none() && req.stream_url.is_none() {
            return Err(anyhow!("No streamable media source available for casting"));
        }

        let (media_url, art_url) = self
            .relay
            .register_media(
                &req.device.host,
                local_path,
                req.stream_url,
                req.mime_type.clone(),
                req.artwork_url.clone(),
            )
            .await?;

        let existing = {
            let guard = self.handle.lock();
            match guard.as_ref() {
                Some((id, ActiveHandle::Chromecast(tx))) if id == &req.device.id => {
                    Some(ActiveHandle::Chromecast(tx.clone()))
                }
                Some((id, ActiveHandle::Dlna(tx))) if id == &req.device.id => {
                    Some(ActiveHandle::Dlna(tx.clone()))
                }
                _ => None,
            }
        };

        if let Some(handle) = existing {
            match handle {
                ActiveHandle::Chromecast(tx) => {
                    tx.send(ChromecastCmd::Load {
                        track_id: req.track_id,
                        media_url,
                        mime_type: req.mime_type,
                        title: req.title,
                        artist: req.artist,
                        album: req.album,
                        artwork_url: art_url,
                        duration_sec: req.duration_sec,
                        start_sec: req.start_sec,
                        autoplay: req.autoplay,
                    })
                    .await
                    .map_err(|_| anyhow!("Chromecast session closed"))?;
                    return Ok(self.session_state());
                }
                ActiveHandle::Dlna(tx) => {
                    tx.send(DlnaCmd::Load {
                        track_id: req.track_id,
                        media_url,
                        mime_type: req.mime_type,
                        title: req.title,
                        artist: req.artist,
                        album: req.album,
                        artwork_url: art_url,
                        duration_sec: req.duration_sec,
                        start_sec: req.start_sec,
                        autoplay: req.autoplay,
                    })
                    .await
                    .map_err(|_| anyhow!("DLNA session closed"))?;
                    return Ok(self.session_state());
                }
            }
        }

        self.disconnect_internal(false).await;

        let device_id = req.device.id.clone();
        match req.device.protocol {
            CastProtocol::Chromecast => {
                let tx = start_chromecast_session(
                    req.device,
                    ChromecastMeta {
                        track_id: req.track_id,
                        media_url,
                        mime_type: req.mime_type,
                        title: req.title,
                        artist: req.artist,
                        album: req.album,
                        artwork_url: art_url,
                        duration_sec: req.duration_sec,
                        start_sec: req.start_sec,
                        autoplay: req.autoplay,
                    },
                    Arc::clone(&self.on_state),
                    Arc::clone(&self.on_track_ended),
                )
                .await?;
                *self.handle.lock() = Some((device_id, ActiveHandle::Chromecast(tx)));
            }
            CastProtocol::Dlna => {
                let tx = start_dlna_session(
                    self.http.clone(),
                    req.device,
                    DlnaMeta {
                        track_id: req.track_id,
                        media_url,
                        mime_type: req.mime_type,
                        title: req.title,
                        artist: req.artist,
                        album: req.album,
                        artwork_url: art_url,
                        duration_sec: req.duration_sec,
                        start_sec: req.start_sec,
                        autoplay: req.autoplay,
                    },
                    Arc::clone(&self.on_state),
                    Arc::clone(&self.on_track_ended),
                )
                .await?;
                *self.handle.lock() = Some((device_id, ActiveHandle::Dlna(tx)));
            }
        }

        Ok(self.session_state())
    }

    pub async fn play(&self) {
        self.dispatch(ChromecastCmd::Play, DlnaCmd::Play).await;
    }

    pub async fn pause(&self) {
        self.dispatch(ChromecastCmd::Pause, DlnaCmd::Pause).await;
    }

    pub async fn seek(&self, seconds: f64) {
        self.dispatch(ChromecastCmd::Seek(seconds), DlnaCmd::Seek(seconds))
            .await;
    }

    pub async fn set_volume(&self, volume: f32) {
        self.dispatch(ChromecastCmd::SetVolume(volume), DlnaCmd::SetVolume(volume))
            .await;
    }

    async fn dispatch(&self, cc_cmd: ChromecastCmd, dlna_cmd: DlnaCmd) {
        let tx = {
            let g = self.handle.lock();
            match g.as_ref().map(|(_, h)| h) {
                Some(ActiveHandle::Chromecast(tx)) => Some(ActiveHandle::Chromecast(tx.clone())),
                Some(ActiveHandle::Dlna(tx)) => Some(ActiveHandle::Dlna(tx.clone())),
                None => None,
            }
        };
        match tx {
            Some(ActiveHandle::Chromecast(c)) => {
                let _ = c.send(cc_cmd).await;
            }
            Some(ActiveHandle::Dlna(d)) => {
                let _ = d.send(dlna_cmd).await;
            }
            None => {}
        }
    }

    pub async fn disconnect(&self) {
        self.disconnect_internal(true).await;
    }

    async fn disconnect_internal(&self, reset_state: bool) {
        let existing = self.handle.lock().take();
        if let Some((_, handle)) = existing {
            match handle {
                ActiveHandle::Chromecast(c) => {
                    let _ = c.send(ChromecastCmd::Disconnect).await;
                }
                ActiveHandle::Dlna(d) => {
                    let _ = d.send(DlnaCmd::Disconnect).await;
                }
            }
        }
        self.relay.clear();
        if reset_state {
            (self.on_state)(CastSessionState::default());
        }
    }
}
