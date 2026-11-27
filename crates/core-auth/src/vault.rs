use anyhow::{anyhow, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use directories::ProjectDirs;
use parking_lot::RwLock;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static APP_DATA_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_app_data_dir_override(dir: PathBuf) {
    let _ = APP_DATA_DIR_OVERRIDE.set(dir);
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSessionPersistence {
    SignedOut,
    Temporary,
    Persistent,
}

#[derive(Debug, Clone)]
pub struct EphemeralSessionOverlay {
    pub yt_cookie_header: Option<String>,
    pub yt_connected: bool,
    pub yt_selected_channel_id: Option<String>,
    pub spotify_sp_dc: Option<String>,
    pub spotify_connected: bool,
    pub source: String,
}

pub struct SecretVault {
    path: PathBuf,
    data: RwLock<VaultData>,
    ephemeral: RwLock<Option<EphemeralSessionOverlay>>,
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
            ephemeral: RwLock::new(None),
        })
    }

    pub fn snapshot(&self) -> VaultData {
        let mut snap = self.data.read().clone();
        if let Some(eph) = self.ephemeral.read().as_ref() {
            snap.yt_cookie_header = eph.yt_cookie_header.clone();
            snap.yt_connected = eph.yt_connected;
            snap.yt_selected_channel_id = eph.yt_selected_channel_id.clone();
            if eph.spotify_sp_dc.is_some() {
                snap.spotify_sp_dc = eph.spotify_sp_dc.clone();
                snap.spotify_connected = eph.spotify_connected;
            }
        }
        snap
    }

    pub fn ephemeral_snapshot(&self) -> Option<EphemeralSessionOverlay> {
        self.ephemeral.read().clone()
    }

    pub fn restore_ephemeral(&self, overlay: Option<EphemeralSessionOverlay>) {
        *self.ephemeral.write() = overlay;
    }

    pub fn set_ephemeral_auth(
        &self,
        yt_cookie_header: Option<String>,
        yt_selected_channel_id: Option<String>,
        spotify_sp_dc: Option<String>,
        source: impl Into<String>,
    ) {
        let clean_yt = yt_cookie_header.filter(|c| !c.trim().is_empty());
        let clean_sp = spotify_sp_dc.filter(|c| !c.trim().is_empty());
        *self.ephemeral.write() = Some(EphemeralSessionOverlay {
            yt_cookie_header: clean_yt,
            yt_connected: true,
            yt_selected_channel_id,
            spotify_sp_dc: clean_sp,
            spotify_connected: true,
            source: source.into(),
        });
    }

    pub fn update_ephemeral_spotify(&self, sp_dc: Option<String>, connected: bool) -> bool {
        let mut guard = self.ephemeral.write();
        let Some(eph) = guard.as_mut() else {
            return false;
        };
        if let Some(val) = sp_dc {
            let trimmed = val.trim().to_string();
            eph.spotify_sp_dc = if trimmed.is_empty() { None } else { Some(trimmed) };
        }
        eph.spotify_connected = connected;
        true
    }

    pub fn update_ephemeral_channel(&self, channel_id: Option<String>) -> bool {
        let mut guard = self.ephemeral.write();
        let Some(eph) = guard.as_mut() else {
            return false;
        };
        eph.yt_selected_channel_id = channel_id;
        true
    }

    pub fn update_ephemeral_connected(&self, connected: bool) -> bool {
        let mut guard = self.ephemeral.write();
        let Some(eph) = guard.as_mut() else {
            return false;
        };
        eph.yt_connected = connected;
        true
    }

    pub fn clear_ephemeral_auth(&self) {
        *self.ephemeral.write() = None;
    }

    pub fn promote_ephemeral_to_persistent(&self) -> Result<bool> {
        let Some(eph) = self.ephemeral.read().clone() else {
            return Ok(false);
        };
        self.update(|data| {
            if eph.yt_cookie_header.is_some() {
                data.yt_cookie_header = eph.yt_cookie_header.clone();
                data.yt_connected = eph.yt_connected;
                data.yt_selected_channel_id = eph.yt_selected_channel_id.clone();
            }
            if eph.spotify_sp_dc.is_some() {
                data.spotify_sp_dc = eph.spotify_sp_dc.clone();
                data.spotify_connected = eph.spotify_connected;
            }
        })?;
        self.clear_ephemeral_auth();
        Ok(true)
    }

    pub fn session_persistence(&self) -> DesktopSessionPersistence {
        if let Some(eph) = self.ephemeral.read().as_ref() {
            if eph
                .yt_cookie_header
                .as_deref()
                .is_some_and(|c| !c.trim().is_empty())
            {
                return DesktopSessionPersistence::Temporary;
            }
        }
        if self
            .data
            .read()
            .yt_cookie_header
            .as_deref()
            .is_some_and(|c| !c.trim().is_empty())
        {
            return DesktopSessionPersistence::Persistent;
        }
        DesktopSessionPersistence::SignedOut
    }

    pub fn ephemeral_source(&self) -> Option<String> {
        self.ephemeral.read().as_ref().map(|e| e.source.clone())
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
    if let Some(dir) = APP_DATA_DIR_OVERRIDE.get() {
        return Ok(dir.clone());
    }
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

const VAULT_ENVELOPE_MAGIC: &[u8; 4] = b"BCV1";
const VAULT_NONCE_LEN: usize = 24;

pub fn protect_bytes_with_key(plain: &[u8], key: &[u8; 32]) -> Result<Vec<u8>> {
    let mut nonce_bytes = [0u8; VAULT_NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let cipher = XChaCha20Poly1305::new(key.into());
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce_bytes), plain)
        .map_err(|_| anyhow!("Failed to encrypt vault bytes"))?;
    let mut out = Vec::with_capacity(VAULT_ENVELOPE_MAGIC.len() + VAULT_NONCE_LEN + ct.len());
    out.extend_from_slice(VAULT_ENVELOPE_MAGIC);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn unprotect_bytes_with_key(cipher_bytes: &[u8], key: &[u8; 32]) -> Result<Vec<u8>> {
    if !cipher_bytes.starts_with(VAULT_ENVELOPE_MAGIC) {
        return Ok(cipher_bytes.to_vec());
    }
    let header_len = VAULT_ENVELOPE_MAGIC.len() + VAULT_NONCE_LEN;
    if cipher_bytes.len() <= header_len {
        return Err(anyhow!("Truncated encrypted vault payload"));
    }
    let nonce = XNonce::from_slice(&cipher_bytes[VAULT_ENVELOPE_MAGIC.len()..header_len]);
    let ct = &cipher_bytes[header_len..];
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(nonce, ct)
        .map_err(|_| anyhow!("Vault decryption failed"))
}

#[cfg(not(windows))]
fn load_or_create_vault_key() -> Result<[u8; 32]> {
    let dir = app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let key_path = dir.join("vault.key");
    if key_path.exists() {
        let bytes = fs::read(&key_path).context("read vault key")?;
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    fs::write(&key_path, key).context("write vault key")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

#[cfg(not(windows))]
pub fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>> {
    let key = load_or_create_vault_key()?;
    protect_bytes_with_key(plain, &key)
}

#[cfg(not(windows))]
pub fn unprotect_bytes(cipher: &[u8]) -> Result<Vec<u8>> {
    if !cipher.starts_with(VAULT_ENVELOPE_MAGIC) {
        return Ok(cipher.to_vec());
    }
    let key = load_or_create_vault_key()?;
    unprotect_bytes_with_key(cipher, &key)
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

    #[test]
    fn aead_envelope_roundtrips_and_rejects_tampering() {
        let key = [42u8; 32];
        let secret = br#"{"ytCookieHeader":"SAPISID=mobile_secret"}"#;
        let mut cipher = protect_bytes_with_key(secret, &key).expect("encrypt");
        assert!(cipher.starts_with(VAULT_ENVELOPE_MAGIC));

        let plain = unprotect_bytes_with_key(&cipher, &key).expect("decrypt");
        assert_eq!(plain, secret);

        let last = cipher.len() - 1;
        cipher[last] ^= 0xFF;
        assert!(unprotect_bytes_with_key(&cipher, &key).is_err());

        let wrong_key = [7u8; 32];
        assert!(unprotect_bytes_with_key(&protect_bytes_with_key(secret, &key).unwrap(), &wrong_key).is_err());
    }

    #[test]
    fn ephemeral_session_never_writes_to_disk_until_promoted() {
        let dir = std::env::temp_dir().join(format!("bitchord-eph-vault-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault.bin");

        let vault = SecretVault::open_at(path.clone()).expect("open clean");
        assert_eq!(vault.session_persistence(), DesktopSessionPersistence::SignedOut);

        vault.set_ephemeral_auth(
            Some("SAPISID=temp_secret".into()),
            Some("0:own".into()),
            Some("sp_dc_temp".into()),
            "qr",
        );
        assert_eq!(vault.session_persistence(), DesktopSessionPersistence::Temporary);
        assert_eq!(vault.ephemeral_source().as_deref(), Some("qr"));
        assert_eq!(vault.snapshot().yt_cookie_header.as_deref(), Some("SAPISID=temp_secret"));
        assert!(!path.exists(), "temporary session must never create vault.bin on disk");

        // Reopening fresh simulates closing and reopening BitChord: temporary session is gone.
        let reopened = SecretVault::open_at(path.clone()).expect("reopen");
        assert_eq!(reopened.session_persistence(), DesktopSessionPersistence::SignedOut);
        assert!(reopened.snapshot().yt_cookie_header.is_none());

        // Promoting temporary session writes encrypted vault.bin to disk.
        assert!(vault.promote_ephemeral_to_persistent().expect("promote"));
        assert_eq!(vault.session_persistence(), DesktopSessionPersistence::Persistent);
        assert!(path.exists());

        let persisted = SecretVault::open_at(path.clone()).expect("reopen promoted");
        assert_eq!(persisted.session_persistence(), DesktopSessionPersistence::Persistent);
        assert_eq!(
            persisted.snapshot().yt_cookie_header.as_deref(),
            Some("SAPISID=temp_secret")
        );
        assert_eq!(
            persisted.snapshot().spotify_sp_dc.as_deref(),
            Some("sp_dc_temp")
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
