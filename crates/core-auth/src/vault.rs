use anyhow::{Context, Result};
use directories::ProjectDirs;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscordUser {
    pub id: String,
    pub name: String,
    pub username: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    #[serde(default)]
    pub yt_cookie_header: Option<String>,
    #[serde(default = "default_true")]
    pub yt_connected: bool,
    #[serde(default)]
    pub yt_selected_channel_id: Option<String>,

    #[serde(default)]
    pub spotify_sp_dc: Option<String>,
    #[serde(default = "default_true")]
    pub spotify_connected: bool,
    #[serde(default)]
    pub spotify_device_id: Option<String>,

    #[serde(default)]
    pub discord_token: Option<String>,
    #[serde(default)]
    pub discord_enabled: bool,
    #[serde(default)]
    pub discord_user: Option<DiscordUser>,

    #[serde(default)]
    pub lastfm_endpoint: Option<String>,
    #[serde(default)]
    pub lastfm_api_key: Option<String>,
    #[serde(default)]
    pub lastfm_api_secret: Option<String>,
    #[serde(default)]
    pub lastfm_session_key: Option<String>,
    #[serde(default)]
    pub lastfm_username: Option<String>,
    #[serde(default)]
    pub listenbrainz_token: Option<String>,
    #[serde(default)]
    pub scrobble_primary_artist_only: bool,

    #[serde(default)]
    pub sources_addons: Vec<StoredAddonConfig>,
    #[serde(default)]
    pub sources_jiosaavn_enabled: bool,
    #[serde(default)]
    pub sources_track_length_tolerance_sec: Option<u8>,
    #[serde(default)]
    pub webdav: Option<StoredWebDavConfig>,
    #[serde(default)]
    pub smb: Option<StoredSmbConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAddonQualityOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredAddonConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub picked_quality: Option<String>,
    #[serde(default)]
    pub quality_options: Vec<StoredAddonQualityOption>,
    #[serde(default = "default_true")]
    pub allow_downloads: bool,
    #[serde(default)]
    pub check_valid_lossless: bool,
    #[serde(default)]
    pub bitchord_auth: bool,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub default_settings: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredWebDavConfig {
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSmbConfig {
    pub host: String,
    pub share: String,
    #[serde(default)]
    pub base_path: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

fn default_true() -> bool {
    true
}

impl Default for VaultData {
    fn default() -> Self {
        Self {
            yt_cookie_header: None,
            yt_connected: true,
            yt_selected_channel_id: None,
            spotify_sp_dc: None,
            spotify_connected: true,
            spotify_device_id: None,
            discord_token: None,
            discord_enabled: false,
            discord_user: None,
            lastfm_endpoint: None,
            lastfm_api_key: None,
            lastfm_api_secret: None,
            lastfm_session_key: None,
            lastfm_username: None,
            listenbrainz_token: None,
            scrobble_primary_artist_only: false,
            sources_addons: Vec::new(),
            sources_jiosaavn_enabled: false,
            sources_track_length_tolerance_sec: Some(5),
            webdav: None,
            smb: None,
        }
    }
}

pub struct SecretVault {
    path: PathBuf,
    data: RwLock<VaultData>,
}

impl SecretVault {
    pub fn open_default() -> Result<Self> {
        let dir = app_data_dir()?;
        fs::create_dir_all(&dir)?;
        Self::open_at(dir.join("vault.bin"))
    }

    pub fn open_at(path: PathBuf) -> Result<Self> {
        let data = if path.exists() {
            let encrypted = fs::read(&path).context("read encrypted vault")?;
            match unprotect_bytes(&encrypted)
                .and_then(|plain| serde_json::from_slice::<VaultData>(&plain).map_err(Into::into))
            {
                Ok(parsed) => parsed,
                Err(err) => {
                    tracing::warn!("Vault could not be decrypted; starting clean: {err}");
                    VaultData::default()
                }
            }
        } else {
            VaultData::default()
        };
        Ok(Self {
            path,
            data: RwLock::new(data),
        })
    }

    pub fn snapshot(&self) -> VaultData {
        self.data.read().clone()
    }

    pub fn update<F>(&self, mutate: F) -> Result<VaultData>
    where
        F: FnOnce(&mut VaultData),
    {
        let next = {
            let mut guard = self.data.write();
            mutate(&mut guard);
            guard.clone()
        };
        self.persist(&next)?;
        Ok(next)
    }

    fn persist(&self, data: &VaultData) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let plain = serde_json::to_vec(data)?;
        let protected = protect_bytes(&plain)?;
        let tmp = self.path.with_extension("bin.tmp");
        fs::write(&tmp, protected)?;
        // Atomic replace avoids losing credentials on sudden shutdown.
        let _ = fs::remove_file(&self.path);
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn app_data_dir() -> Result<PathBuf> {
    if let Some(dirs) = ProjectDirs::from("in", "bitchord", "BitChord") {
        Ok(dirs.data_local_dir().to_path_buf())
    } else {
        Ok(std::env::temp_dir().join("BitChord"))
    }
}

#[cfg(windows)]
pub fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // DPAPI binds ciphertext to the current Windows user profile with no UI prompt.
    unsafe {
        CryptProtectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .context("Windows DPAPI CryptProtectData failed")?;
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let result = slice.to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        Ok(result)
    }
}

#[cfg(windows)]
pub fn unprotect_bytes(cipher: &[u8]) -> Result<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .context("Windows DPAPI CryptUnprotectData failed")?;
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let result = slice.to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        Ok(result)
    }
}

#[cfg(not(windows))]
pub fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
pub fn unprotect_bytes(cipher: &[u8]) -> Result<Vec<u8>> {
    Ok(cipher.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_roundtrip_preserves_secret_bytes() {
        let secret = br#"{"ytCookieHeader":"SAPISID=test_cookie_value"}"#;
        let cipher = protect_bytes(secret).expect("protect");
        let plain = unprotect_bytes(&cipher).expect("unprotect");
        assert_eq!(plain, secret);
    }
}
