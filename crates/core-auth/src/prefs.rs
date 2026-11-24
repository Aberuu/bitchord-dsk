use crate::vault::app_data_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrefs {
    #[serde(default)]
    pub minimize_to_tray: bool,
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
    fn missing_prefs_file_defaults_minimize_to_tray_to_false() {
        let path = temp_prefs_path("missing");
        let _ = fs::remove_dir_all(path.parent().unwrap());
        let loaded = DesktopPrefs::load_from(&path);
        assert!(!loaded.minimize_to_tray);
    }

    #[test]
    fn prefs_roundtrip_persists_true_and_false() {
        let path = temp_prefs_path("roundtrip");
        let _ = fs::remove_dir_all(path.parent().unwrap());

        DesktopPrefs {
            minimize_to_tray: true,
        }
        .save_to(&path)
        .expect("save true");
        assert!(DesktopPrefs::load_from(&path).minimize_to_tray);

        DesktopPrefs {
            minimize_to_tray: false,
        }
        .save_to(&path)
        .expect("save false");
        assert!(!DesktopPrefs::load_from(&path).minimize_to_tray);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupt_json_falls_back_to_default_false() {
        let path = temp_prefs_path("corrupt");
        let _ = fs::remove_dir_all(path.parent().unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not valid json").unwrap();
        assert!(!DesktopPrefs::load_from(&path).minimize_to_tray);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
