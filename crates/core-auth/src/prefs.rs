use crate::vault::app_data_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrefs {
    #[serde(default)]
    pub minimize_to_tray: bool,
    #[serde(default = "default_true")]
    pub auto_check_updates: bool,
    #[serde(default = "default_true")]
    pub auto_download_updates: bool,
    #[serde(default)]
    pub update_feed_url: Option<String>,
    #[serde(default)]
    pub skipped_version: Option<String>,
    #[serde(default)]
    pub mobile_sync_port: Option<u16>,
    #[serde(default)]
    pub skip_sign_in_prompt: bool,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            minimize_to_tray: false,
            auto_check_updates: true,
            auto_download_updates: true,
            update_feed_url: None,
            skipped_version: None,
            mobile_sync_port: None,
            skip_sign_in_prompt: false,
        }
    }
}

impl DesktopPrefs {
    pub fn default_path() -> PathBuf {
        app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("BitChord"))
            .join("desktop-prefs.json")
    }

    pub fn load_default() -> (Self, PathBuf) {
        let path = Self::default_path();
        let prefs = Self::load_from(&path);
        (prefs, path)
    }

    pub fn load_from(path: &Path) -> Self {
        let Ok(raw) = fs::read(path) else {
            return Self::default();
        };
        serde_json::from_slice::<Self>(&raw).unwrap_or_else(|err| {
            tracing::warn!("Could not parse desktop preferences, using defaults: {err}");
            Self::default()
        })
    }

    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(self)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, body)?;
        let _ = fs::remove_file(path);
        fs::rename(&tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_prefs_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("bitchord-prefs-test-{}-{name}", std::process::id()))
            .join("desktop-prefs.json")
    }

    #[test]
    fn missing_prefs_file_uses_sensible_defaults() {
        let path = temp_prefs_path("missing");
        let _ = fs::remove_dir_all(path.parent().unwrap());
        let loaded = DesktopPrefs::load_from(&path);
        assert!(!loaded.minimize_to_tray);
        assert!(loaded.auto_check_updates);
        assert!(loaded.auto_download_updates);
        assert!(loaded.update_feed_url.is_none());
        assert!(loaded.skipped_version.is_none());
    }

    #[test]
    fn legacy_prefs_json_preserves_updater_defaults() {
        let path = temp_prefs_path("legacy");
        let _ = fs::remove_dir_all(path.parent().unwrap());
        fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        fs::write(&path, r#"{"minimizeToTray":true}"#).expect("write legacy");
        let loaded = DesktopPrefs::load_from(&path);
        assert!(loaded.minimize_to_tray);
        assert!(loaded.auto_check_updates);
        assert!(loaded.auto_download_updates);
        assert!(loaded.update_feed_url.is_none());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn prefs_roundtrip_persists_all_fields() {
        let path = temp_prefs_path("roundtrip");
        let _ = fs::remove_dir_all(path.parent().unwrap());

        DesktopPrefs {
            minimize_to_tray: true,
            auto_check_updates: false,
            auto_download_updates: false,
            update_feed_url: Some("http://127.0.0.1:8787/releases.json".into()),
            skipped_version: Some("0.9.0".into()),
            mobile_sync_port: Some(48221),
            skip_sign_in_prompt: true,
        }
        .save_to(&path)
        .expect("save custom");
        let loaded = DesktopPrefs::load_from(&path);
        assert!(loaded.minimize_to_tray);
        assert!(!loaded.auto_check_updates);
        assert!(!loaded.auto_download_updates);
        assert_eq!(
            loaded.update_feed_url.as_deref(),
            Some("http://127.0.0.1:8787/releases.json")
        );
        assert_eq!(loaded.skipped_version.as_deref(), Some("0.9.0"));
        assert_eq!(loaded.mobile_sync_port, Some(48221));
        assert!(loaded.skip_sign_in_prompt);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
