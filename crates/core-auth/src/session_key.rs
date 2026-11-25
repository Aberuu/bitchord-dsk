use crate::youtube::extract_signing_secret;
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

const PREFIX_KEYLESS: &str = "BC1K-";
const PREFIX_PINNED: &str = "BC1P-";
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const PIN_KDF_ROUNDS: usize = 50_000;
const MAX_DECOMPRESSED_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OneKeyPayload {
    pub v: u8,
    pub yt_cookie_header: String,
    #[serde(default)]
    pub yt_selected_channel_id: Option<String>,
    #[serde(default)]
    pub spotify_sp_dc: Option<String>,
    pub issued_at_ms: i64,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
}

pub fn current_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn encode_one_key(payload: &OneKeyPayload, pin: Option<&str>) -> Result<String> {
    if payload.yt_cookie_header.trim().is_empty()
        || extract_signing_secret(&payload.yt_cookie_header).is_none()
    {
        return Err(anyhow!("YouTube Music session is missing required signing cookies"));
    }

    let json = serde_json::to_vec(payload)?;
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(&json)?;
    let compressed = encoder.finish()?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let clean_pin = pin.map(str::trim).filter(|p| !p.is_empty());
    if let Some(pin_val) = clean_pin {
        let mut salt = [0u8; SALT_LEN];
        rand::rng().fill_bytes(&mut salt);
        let key = derive_pin_key(&salt, pin_val);
        let cipher = XChaCha20Poly1305::new((&key).into());
        let ct = cipher
            .encrypt(nonce, compressed.as_ref())
            .map_err(|_| anyhow!("Failed to encrypt PIN-protected 1-Key Session"))?;
        let mut raw = Vec::with_capacity(SALT_LEN + NONCE_LEN + ct.len());
        raw.extend_from_slice(&salt);
        raw.extend_from_slice(&nonce_bytes);
        raw.extend_from_slice(&ct);
        Ok(format!("{PREFIX_PINNED}{}", URL_SAFE_NO_PAD.encode(raw)))
    } else {
        let mut key = [0u8; KEY_LEN];
        rand::rng().fill_bytes(&mut key);
        let cipher = XChaCha20Poly1305::new((&key).into());
        let ct = cipher
            .encrypt(nonce, compressed.as_ref())
            .map_err(|_| anyhow!("Failed to encrypt 1-Key Session"))?;
        let mut raw = Vec::with_capacity(KEY_LEN + NONCE_LEN + ct.len());
        raw.extend_from_slice(&key);
        raw.extend_from_slice(&nonce_bytes);
        raw.extend_from_slice(&ct);
        Ok(format!("{PREFIX_KEYLESS}{}", URL_SAFE_NO_PAD.encode(raw)))
    }
}

pub fn decode_one_key(raw_key: &str, pin: Option<&str>) -> Result<OneKeyPayload> {
    decode_one_key_at(raw_key, pin, current_epoch_ms())
}

pub fn decode_one_key_at(raw_key: &str, pin: Option<&str>, now_ms: i64) -> Result<OneKeyPayload> {
    let trimmed = raw_key.trim();
    let compressed = if let Some(encoded) = trimmed.strip_prefix(PREFIX_PINNED) {
        let pin_val = pin
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| anyhow!("This 1-Key Session requires its PIN code"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|_| anyhow!("Malformed 1-Key Session code"))?;
        if bytes.len() <= SALT_LEN + NONCE_LEN {
            return Err(anyhow!("Incomplete 1-Key Session payload"));
        }
        let salt = &bytes[..SALT_LEN];
        let nonce = XNonce::from_slice(&bytes[SALT_LEN..SALT_LEN + NONCE_LEN]);
        let ct = &bytes[SALT_LEN + NONCE_LEN..];
        let key = derive_pin_key(salt, pin_val);
        let cipher = XChaCha20Poly1305::new((&key).into());
        cipher
            .decrypt(nonce, ct)
            .map_err(|_| anyhow!("Incorrect PIN or corrupted 1-Key Session code"))?
    } else if let Some(encoded) = trimmed.strip_prefix(PREFIX_KEYLESS) {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|_| anyhow!("Malformed 1-Key Session code"))?;
        if bytes.len() <= KEY_LEN + NONCE_LEN {
            return Err(anyhow!("Incomplete 1-Key Session payload"));
        }
        let key: [u8; KEY_LEN] = bytes[..KEY_LEN]
            .try_into()
            .map_err(|_| anyhow!("Invalid 1-Key key bytes"))?;
        let nonce = XNonce::from_slice(&bytes[KEY_LEN..KEY_LEN + NONCE_LEN]);
        let ct = &bytes[KEY_LEN + NONCE_LEN..];
        let cipher = XChaCha20Poly1305::new((&key).into());
        cipher
            .decrypt(nonce, ct)
            .map_err(|_| anyhow!("Corrupted or tampered 1-Key Session code"))?
    } else {
        return Err(anyhow!(
            "Unsupported key format. Expected a code starting with BC1K- or BC1P-."
        ));
    };

    let decoder = DeflateDecoder::new(&compressed[..]);
    let mut limited = decoder.take((MAX_DECOMPRESSED_BYTES + 1) as u64);
    let mut json = Vec::new();
    limited
        .read_to_end(&mut json)
        .map_err(|_| anyhow!("Could not decompress 1-Key Session payload"))?;
    if json.len() > MAX_DECOMPRESSED_BYTES {
        return Err(anyhow!("1-Key Session payload exceeds size limit"));
    }

    let payload: OneKeyPayload =
        serde_json::from_slice(&json).map_err(|_| anyhow!("Invalid 1-Key Session JSON"))?;
    if payload.v != 1 {
        return Err(anyhow!("Unsupported 1-Key Session version {}", payload.v));
    }
    if extract_signing_secret(&payload.yt_cookie_header).is_none() {
        return Err(anyhow!("1-Key Session does not contain valid YouTube credentials"));
    }
    if let Some(exp) = payload.expires_at_ms {
        if now_ms > exp {
            return Err(anyhow!("This 1-Key Session has expired"));
        }
    }
    Ok(payload)
}

fn derive_pin_key(salt: &[u8], pin: &str) -> [u8; KEY_LEN] {
    let normalized = pin.trim().to_ascii_uppercase();
    let mut state = {
        let mut h = Sha256::new();
        h.update(b"bitchord-1k:");
        h.update(salt);
        h.update(normalized.as_bytes());
        h.finalize()
    };
    for _ in 1..PIN_KDF_ROUNDS {
        let mut h = Sha256::new();
        h.update(state);
        h.update(salt);
        state = h.finalize();
    }
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&state);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload(expires_at_ms: Option<i64>) -> OneKeyPayload {
        OneKeyPayload {
            v: 1,
            yt_cookie_header: "SID=abc; SAPISID=xyz123secret; __Secure-3PAPISID=p3".into(),
            yt_selected_channel_id: Some("0:own".into()),
            spotify_sp_dc: Some("sp_dc_token".into()),
            issued_at_ms: 1_700_000_000_000,
            expires_at_ms,
        }
    }

    #[test]
    fn keyless_roundtrip_and_tamper_rejection() {
        let payload = sample_payload(None);
        let key = encode_one_key(&payload, None).expect("encode");
        assert!(key.starts_with(PREFIX_KEYLESS));

        let decoded = decode_one_key_at(&key, None, 1_700_000_010_000).expect("decode");
        assert_eq!(decoded, payload);

        let mut tampered = key.clone();
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert!(decode_one_key_at(&tampered, None, 1_700_000_010_000).is_err());
    }

    #[test]
    fn pinned_key_requires_exact_pin_and_enforces_expiry() {
        let payload = sample_payload(Some(1_700_000_060_000));
        let key = encode_one_key(&payload, Some("482910")).expect("encode with pin");
        assert!(key.starts_with(PREFIX_PINNED));

        assert!(decode_one_key_at(&key, None, 1_700_000_010_000).is_err());
        assert!(decode_one_key_at(&key, Some("000000"), 1_700_000_010_000).is_err());
        assert!(decode_one_key_at(&key, Some("482910"), 1_700_000_090_000).is_err());

        let ok = decode_one_key_at(&key, Some("482910"), 1_700_000_020_000).expect("valid pin");
        assert_eq!(ok, payload);
    }
}
