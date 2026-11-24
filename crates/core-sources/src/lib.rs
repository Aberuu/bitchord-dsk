pub mod addon;
pub mod jiosaavn;
pub mod model;
pub mod smb;
pub mod webdav;

pub use addon::{identify_and_probe, probe_addon, resolve_addon_stream, search_addon};
pub use jiosaavn::{decrypt_media_url, search_songs as search_jiosaavn, select_best_saavn_stream};
pub use model::{
    addon_has_lossless_capability, codec_from_name, AddonHealthStatus, AddonProbeResult,
    RemoteTrackItem, ResolvedSourceStream, SmbStatusView, SourceCandidateTrack, SourcesSnapshot,
    WebDavStatusView,
};

use anyhow::Result;
use core_auth::{
    SecretVault, StoredAddonConfig, StoredSmbConfig, StoredWebDavConfig, VaultData,
};
use std::collections::HashMap;
use std::sync::Arc;

pub const DEFAULT_TOLERANCE_SEC: u8 = 5;
pub const MAX_TOLERANCE_SEC: u8 = 10;

pub struct SourcesService {
    vault: Arc<SecretVault>,
    http: reqwest::Client,
}

impl SourcesService {
    pub fn new(vault: Arc<SecretVault>, http: reqwest::Client) -> Self {
        Self { vault, http }
    }

    pub fn snapshot(&self) -> SourcesSnapshot {
        snapshot_from_vault(&self.vault.snapshot())
    }

    pub fn set_addons(&self, addons: Vec<StoredAddonConfig>) -> Result<SourcesSnapshot> {
        let next = self.vault.update(|data| {
            data.sources_addons = addons;
        })?;
        Ok(snapshot_from_vault(&next))
    }

    pub fn set_jiosaavn_enabled(&self, enabled: bool) -> Result<SourcesSnapshot> {
        let next = self.vault.update(|data| {
            data.sources_jiosaavn_enabled = enabled;
        })?;
        Ok(snapshot_from_vault(&next))
    }

    pub fn set_tolerance_sec(&self, seconds: u8) -> Result<SourcesSnapshot> {
        let clamped = seconds.min(MAX_TOLERANCE_SEC);
        let next = self.vault.update(|data| {
            data.sources_track_length_tolerance_sec = Some(clamped);
        })?;
        Ok(snapshot_from_vault(&next))
    }

    pub async fn identify_addon(
        &self,
        raw_url: String,
        existing_id: Option<String>,
    ) -> Result<AddonProbeResult> {
        let snap = self.vault.snapshot();
        let existing = existing_id
            .as_deref()
            .and_then(|id| snap.sources_addons.iter().find(|a| a.id == id));
        identify_and_probe(&self.http, &raw_url, existing).await
    }

    pub async fn probe_addon_by_id(&self, addon_id: &str) -> Result<AddonHealthStatus> {
        let snap = self.vault.snapshot();
        let cfg = snap
            .sources_addons
            .into_iter()
            .find(|a| a.id == addon_id)
            .ok_or_else(|| anyhow::anyhow!("Addon not found"))?;
        Ok(probe_addon(&self.http, &cfg).await)
    }

    pub async fn search_source(
        &self,
        source_id: &str,
        query: &str,
        title: Option<&str>,
        artist: Option<&str>,
    ) -> Result<Vec<SourceCandidateTrack>> {
        if source_id == "jiosaavn" {
            return search_jiosaavn(&self.http, query).await;
        }
        let cfg = self
            .vault
            .snapshot()
            .sources_addons
            .into_iter()
            .find(|a| a.id == source_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown source: {source_id}"))?;
        search_addon(&self.http, &cfg, query, title, artist).await
    }

    pub async fn resolve_candidate_stream(
        &self,
        candidate: &SourceCandidateTrack,
    ) -> Result<ResolvedSourceStream> {
        if let Some(url) = candidate.stream_url.as_ref().filter(|s| !s.is_empty()) {
            return Ok(ResolvedSourceStream {
                source_id: candidate.source_id.clone(),
                source_name: candidate.source_name.clone(),
                track_id: candidate.id.clone(),
                url: url.clone(),
                headers: candidate.headers.clone(),
                mime_type: candidate.mime_type.clone(),
                format: candidate.format.clone(),
                codec: candidate.codec.clone(),
                bitrate_kbps: candidate.bitrate_kbps,
                sample_rate_hz: candidate.sample_rate_hz,
                bit_depth: candidate.bit_depth,
                lossless: candidate.lossless,
            });
        }
        let cfg = self
            .vault
            .snapshot()
            .sources_addons
            .into_iter()
            .find(|a| a.id == candidate.source_id)
            .ok_or_else(|| anyhow::anyhow!("Addon {} no longer exists", candidate.source_id))?;
        resolve_addon_stream(&self.http, &cfg, candidate).await
    }

    pub async fn test_webdav(&self, url: &str, username: &str, password: Option<&str>) -> Result<()> {
        let effective_pw = match password {
            Some(p) => p.to_string(),
            None => self
                .vault
                .snapshot()
                .webdav
                .map(|w| w.password)
                .unwrap_or_default(),
        };
        webdav::test_connection(&self.http, url, username, &effective_pw).await
    }

    pub fn save_webdav(
        &self,
        url: String,
        username: String,
        password: Option<String>,
    ) -> Result<SourcesSnapshot> {
        let normalized = webdav::normalize_url(&url);
        let next = self.vault.update(|data| {
            let final_pw = match password {
                Some(p) => p,
                None => data.webdav.as_ref().map(|w| w.password.clone()).unwrap_or_default(),
            };
            data.webdav = Some(StoredWebDavConfig {
                url: normalized,
                username: username.trim().to_string(),
                password: final_pw,
            });
        })?;
        Ok(snapshot_from_vault(&next))
    }

    pub fn disconnect_webdav(&self) -> Result<SourcesSnapshot> {
        let next = self.vault.update(|data| {
            data.webdav = None;
        })?;
        Ok(snapshot_from_vault(&next))
    }

    pub async fn list_webdav_tracks(&self) -> Result<(Vec<RemoteTrackItem>, Option<String>)> {
        let Some(cfg) = self.vault.snapshot().webdav else {
            return Ok((Vec::new(), None));
        };
        let auth = webdav::basic_auth_header(&cfg.username, &cfg.password);
        let items = webdav::list_library(&self.http, &cfg).await?;
        Ok((items, auth))
    }

    pub fn webdav_config(&self) -> Option<StoredWebDavConfig> {
        self.vault.snapshot().webdav
    }

    pub async fn fetch_webdav_bytes(&self, target_url: &str) -> Result<Vec<u8>> {
        let cfg = self
            .vault
            .snapshot()
            .webdav
            .ok_or_else(|| anyhow::anyhow!("WebDAV is not configured"))?;
        let mut req = self.http.get(target_url);
        if let Some(auth) = webdav::basic_auth_header(&cfg.username, &cfg.password) {
            req = req.header(reqwest::header::AUTHORIZATION, auth);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("WebDAV fetch HTTP {}", resp.status().as_u16()));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    pub async fn test_smb(
        &self,
        host: &str,
        share: &str,
        base_path: &str,
        username: &str,
        password: Option<&str>,
    ) -> Result<()> {
        let effective_pw = match password {
            Some(p) => p.to_string(),
            None => self
                .vault
                .snapshot()
                .smb
                .map(|s| s.password)
                .unwrap_or_default(),
        };
        let cfg = StoredSmbConfig {
            host: host.trim().to_string(),
            share: share.trim().trim_matches(['/', '\\']).to_string(),
            base_path: smb::normalize_base_path(base_path),
            username: username.trim().to_string(),
            password: effective_pw,
        };
        smb::test_connection(&cfg).await
    }

    pub fn save_smb(
        &self,
        host: String,
        share: String,
        base_path: String,
        username: String,
        password: Option<String>,
    ) -> Result<SourcesSnapshot> {
        let next = self.vault.update(|data| {
            let final_pw = match password {
                Some(p) => p,
                None => data.smb.as_ref().map(|s| s.password.clone()).unwrap_or_default(),
            };
            data.smb = Some(StoredSmbConfig {
                host: host.trim().to_string(),
                share: share.trim().trim_matches(['/', '\\']).to_string(),
                base_path: smb::normalize_base_path(&base_path),
                username: username.trim().to_string(),
                password: final_pw,
            });
        })?;
        Ok(snapshot_from_vault(&next))
    }

    pub fn disconnect_smb(&self) -> Result<SourcesSnapshot> {
        let next = self.vault.update(|data| {
            data.smb = None;
        })?;
        Ok(snapshot_from_vault(&next))
    }

    pub async fn list_smb_tracks(&self) -> Result<(Vec<RemoteTrackItem>, Option<StoredSmbConfig>)> {
        let Some(cfg) = self.vault.snapshot().smb else {
            return Ok((Vec::new(), None));
        };
        let items = smb::list_library(&cfg).await?;
        Ok((items, Some(cfg)))
    }

    pub fn smb_config(&self) -> Option<StoredSmbConfig> {
        self.vault.snapshot().smb
    }

    pub async fn fetch_http_bytes(
        &self,
        url: &str,
        headers: &HashMap<String, String>,
    ) -> Result<Vec<u8>> {
        let mut req = self.http.get(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("Stream HTTP {}", resp.status().as_u16()));
        }
        Ok(resp.bytes().await?.to_vec())
    }
}

fn snapshot_from_vault(data: &VaultData) -> SourcesSnapshot {
    let webdav = match data.webdav.as_ref().filter(|w| webdav::is_configured(&w.url)) {
        Some(w) => WebDavStatusView {
            configured: true,
            url: w.url.clone(),
            username: w.username.clone(),
            has_password: !w.password.is_empty(),
        },
        None => WebDavStatusView {
            configured: false,
            url: String::new(),
            username: String::new(),
            has_password: false,
        },
    };

    let smb = match data.smb.as_ref().filter(|s| smb::is_configured(&s.host, &s.share)) {
        Some(s) => SmbStatusView {
            configured: true,
            host: s.host.clone(),
            share: s.share.clone(),
            base_path: s.base_path.clone(),
            username: s.username.clone(),
            has_password: !s.password.is_empty(),
        },
        None => SmbStatusView {
            configured: false,
            host: String::new(),
            share: String::new(),
            base_path: String::new(),
            username: String::new(),
            has_password: false,
        },
    };

    SourcesSnapshot {
        addons: data.sources_addons.clone(),
        jiosaavn_enabled: data.sources_jiosaavn_enabled,
        track_length_tolerance_sec: data
            .sources_track_length_tolerance_sec
            .unwrap_or(DEFAULT_TOLERANCE_SEC)
            .min(MAX_TOLERANCE_SEC),
        webdav,
        smb,
    }
}
