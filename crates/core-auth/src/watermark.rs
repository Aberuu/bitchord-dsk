use serde::Serialize;

const KEY_SHARE_A: [u8; 32] = [
    0x97, 0x60, 0x9a, 0x54, 0xce, 0x97, 0xab, 0xe8, 0xf2, 0xd1, 0xf3, 0xb3,
    0x57, 0xaf, 0x54, 0x7b, 0x4e, 0xde, 0x53, 0x7a, 0x49, 0x0d, 0x2d, 0x53,
    0xb7, 0x5b, 0x74, 0x0d, 0xe6, 0xda, 0x64, 0x1d,
];

const KEY_SHARE_B: [u8; 32] = [
    0x41, 0xc1, 0xd9, 0xdd, 0xb9, 0x87, 0x38, 0x52, 0x03, 0x42, 0x5d, 0x3d,
    0x54, 0xb3, 0x60, 0xcc, 0x82, 0x87, 0x99, 0xc5, 0x34, 0x3f, 0xdc, 0x29,
    0x07, 0x4b, 0x00, 0xfa, 0x6b, 0x55, 0x64, 0x67,
];

const WATERMARK_NONCE: [u8; 12] = [
    0xb9, 0x73, 0xbe, 0xd5, 0xe9, 0x72, 0x2e, 0x4d, 0xd2, 0x2e, 0x91, 0xf2,
];

const ENCRYPTED_WATERMARK: [u8; 392] = [
    0x92, 0xfa, 0xad, 0x90, 0x88, 0xbb, 0x4f, 0xb2, 0x0a, 0xc6, 0xc5, 0x86,
    0x90, 0x09, 0xb1, 0xa3, 0xc6, 0xb2, 0x06, 0x50, 0x71, 0xab, 0x02, 0xf9,
    0x6d, 0x43, 0xd6, 0x75, 0xa1, 0x32, 0x22, 0xed, 0x17, 0xdf, 0xd6, 0x35,
    0xb3, 0x5c, 0xf6, 0xdd, 0xcf, 0xc5, 0xa7, 0x15, 0xc0, 0x8e, 0xe5, 0xb4,
    0xae, 0x36, 0xcf, 0x07, 0x0c, 0xc3, 0x28, 0x7c, 0x80, 0xbb, 0xa6, 0x4f,
    0x21, 0x07, 0x34, 0x63, 0xc6, 0xa0, 0x68, 0xbd, 0xaa, 0x31, 0x9d, 0x7d,
    0xd9, 0x7f, 0xa5, 0x37, 0x0d, 0x42, 0x88, 0x68, 0x55, 0x7d, 0x6d, 0x06,
    0xfc, 0x4c, 0x88, 0x1a, 0x99, 0x24, 0xc9, 0x29, 0xf0, 0xa4, 0x1a, 0x77,
    0xae, 0x3b, 0xac, 0xff, 0x17, 0x01, 0x82, 0x64, 0xf4, 0x49, 0x08, 0x8f,
    0x66, 0x8a, 0x59, 0xa6, 0xa0, 0xb0, 0x34, 0x84, 0x3b, 0xa3, 0xcb, 0xcd,
    0x61, 0xd3, 0x6e, 0xbd, 0x29, 0x54, 0x63, 0xa2, 0x35, 0xcc, 0x51, 0x15,
    0x10, 0xee, 0x87, 0x5b, 0x45, 0x7e, 0x68, 0x20, 0x47, 0x57, 0xed, 0x97,
    0x43, 0xdc, 0xdd, 0x04, 0x59, 0xdb, 0xb1, 0x02, 0xa0, 0xba, 0x8d, 0xfb,
    0x3a, 0xcf, 0x0f, 0xc0, 0xf4, 0x49, 0xe0, 0xc9, 0x48, 0x1c, 0x55, 0xca,
    0x52, 0x17, 0x5e, 0xf8, 0xce, 0x79, 0xce, 0x38, 0xe5, 0x51, 0x83, 0xae,
    0xb0, 0x95, 0xbf, 0x58, 0x8c, 0x76, 0x45, 0xce, 0x5d, 0x31, 0x3a, 0xca,
    0xf2, 0x5c, 0xc6, 0xb2, 0xd8, 0x34, 0x29, 0x2c, 0x22, 0x7e, 0x84, 0xf7,
    0xb6, 0xb6, 0x57, 0xfe, 0x45, 0x67, 0xc9, 0x81, 0x3b, 0x94, 0x56, 0x59,
    0x88, 0xde, 0x5d, 0xed, 0x09, 0x8f, 0x37, 0x86, 0xac, 0x5e, 0x34, 0x52,
    0xbb, 0x0d, 0xdf, 0xfb, 0x40, 0xdf, 0xc0, 0xa4, 0xda, 0x41, 0xc7, 0xa6,
    0xfe, 0x05, 0x91, 0x65, 0xc5, 0xfc, 0xbb, 0x39, 0xc6, 0xf0, 0x28, 0x1a,
    0x85, 0x34, 0xc9, 0xe8, 0xdf, 0xc6, 0xba, 0x3d, 0xe8, 0x1a, 0x4a, 0xbd,
    0xb6, 0x96, 0xec, 0xa8, 0x5e, 0xe0, 0x4e, 0x73, 0xd2, 0xa7, 0x8b, 0x11,
    0xe2, 0x9a, 0xb5, 0x62, 0xe8, 0xc2, 0x76, 0xea, 0xab, 0xb7, 0x92, 0xf7,
    0x97, 0x77, 0xa0, 0x21, 0x42, 0xcc, 0x17, 0x1e, 0xe1, 0x8a, 0xf9, 0x94,
    0x15, 0x6c, 0x8e, 0xef, 0xc0, 0xa7, 0xec, 0x4e, 0xee, 0xda, 0x85, 0xc5,
    0xf3, 0xeb, 0x80, 0x20, 0x42, 0x84, 0xe2, 0xb3, 0x3e, 0xc5, 0x2d, 0x3b,
    0x39, 0x74, 0x19, 0x9a, 0x79, 0xd3, 0xeb, 0xab, 0x53, 0xd4, 0xb3, 0xbe,
    0x84, 0x23, 0x9c, 0xdb, 0x86, 0x8d, 0x6e, 0x8b, 0x0b, 0x32, 0x74, 0x87,
    0x88, 0xe9, 0xa8, 0xd0, 0x9b, 0xfa, 0x77, 0xf5, 0x6f, 0x1f, 0xf2, 0x92,
    0xb0, 0x1b, 0x10, 0x8b, 0xb1, 0xb6, 0x0e, 0xd3, 0x29, 0xd9, 0xdb, 0x1f,
    0x21, 0x58, 0x4f, 0xe5, 0x76, 0xa0, 0xbd, 0xb6, 0x9c, 0x14, 0x2e, 0x75,
    0x7b, 0x46, 0x71, 0x6a, 0xde, 0xfb, 0x6c, 0xa2,
];

const WATERMARK_TAG: u64 = 0x035f_e707_19d2_76ad;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedWatermarkStatus {
    pub credit: String,
    pub author: String,
    pub github_profile_url: String,
    pub github_repo_url: String,
    pub formatted: String,
    pub integrity_valid: bool,
}

fn assemble_key(share_a: &[u8; 32], share_b: &[u8; 32]) -> [u8; 32] {
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = share_a[i] ^ share_b[i];
    }
    key
}

fn read_u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[inline]
fn quarter_round(s: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
    s[a] = s[a].wrapping_add(s[b]);
    s[d] = (s[d] ^ s[a]).rotate_left(16);
    s[c] = s[c].wrapping_add(s[d]);
    s[b] = (s[b] ^ s[c]).rotate_left(12);
    s[a] = s[a].wrapping_add(s[b]);
    s[d] = (s[d] ^ s[a]).rotate_left(8);
    s[c] = s[c].wrapping_add(s[d]);
    s[b] = (s[b] ^ s[c]).rotate_left(7);
}

fn chacha20_block(key: &[u8; 32], counter: u32, nonce: &[u8; 12]) -> [u8; 64] {
    let init = [
        0x6170_7865,
        0x3320_646e,
        0x7962_2d32,
        0x6b20_6574,
        read_u32_le(&key[0..4]),
        read_u32_le(&key[4..8]),
        read_u32_le(&key[8..12]),
        read_u32_le(&key[12..16]),
        read_u32_le(&key[16..20]),
        read_u32_le(&key[20..24]),
        read_u32_le(&key[24..28]),
        read_u32_le(&key[28..32]),
        counter,
        read_u32_le(&nonce[0..4]),
        read_u32_le(&nonce[4..8]),
        read_u32_le(&nonce[8..12]),
    ];
    let mut work = init;
    for _ in 0..10 {
        quarter_round(&mut work, 0, 4, 8, 12);
        quarter_round(&mut work, 1, 5, 9, 13);
        quarter_round(&mut work, 2, 6, 10, 14);
        quarter_round(&mut work, 3, 7, 11, 15);
        quarter_round(&mut work, 0, 5, 10, 15);
        quarter_round(&mut work, 1, 6, 11, 12);
        quarter_round(&mut work, 2, 7, 8, 13);
        quarter_round(&mut work, 3, 4, 9, 14);
    }

    let mut out = [0u8; 64];
    for (i, chunk) in out.chunks_exact_mut(4).enumerate() {
        chunk.copy_from_slice(&work[i].wrapping_add(init[i]).to_le_bytes());
    }
    out
}

fn chacha20_xor(key: &[u8; 32], counter_start: u32, nonce: &[u8; 12], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for (blk_idx, chunk) in data.chunks(64).enumerate() {
        let keystream = chacha20_block(key, counter_start.wrapping_add(blk_idx as u32), nonce);
        for (b, ks) in chunk.iter().zip(keystream.iter()) {
            out.push(b ^ ks);
        }
    }
    out
}

fn compute_integrity_tag(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8]) -> u64 {
    // Derive an authentication key from block 0 so ciphertext blocks begin cleanly at counter 1.
    let auth_key = chacha20_block(key, 0, nonce);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let prime: u64 = 0x0100_0000_01b3;
    for part in [auth_key.as_slice(), nonce.as_slice(), plaintext] {
        for &b in part {
            h ^= b as u64;
            h = h.wrapping_mul(prime);
        }
    }
    h ^= h >> 30;
    h = h.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94d0_49bb_1331_11eb);
    h ^= h >> 31;
    h
}

fn extract_formatted_field(formatted: &str, prefix: &str) -> String {
    formatted
        .lines()
        .find_map(|line| {
            let trimmed = line.trim_start();
            let rest = trimmed.strip_prefix(prefix)?;
            Some(rest.trim_start_matches([' ', ':']).trim().to_string())
        })
        .unwrap_or_default()
}

pub fn decode_watermark_bytes(
    share_a: &[u8; 32],
    share_b: &[u8; 32],
    nonce: &[u8; 12],
    cipher: &[u8],
    expected_tag: u64,
) -> EmbeddedWatermarkStatus {
    let key = assemble_key(share_a, share_b);
    let plain = chacha20_xor(&key, 1, nonce, cipher);
    let integrity_valid = compute_integrity_tag(&key, nonce, &plain) == expected_tag;
    let formatted = if integrity_valid {
        String::from_utf8(plain).unwrap_or_default()
    } else {
        String::new()
    };

    EmbeddedWatermarkStatus {
        credit: extract_formatted_field(&formatted, "Credit"),
        author: extract_formatted_field(&formatted, "Developer"),
        github_profile_url: extract_formatted_field(&formatted, "GitHub"),
        github_repo_url: extract_formatted_field(&formatted, "Repository"),
        formatted,
        integrity_valid,
    }
}

pub fn verify_embedded_watermark() -> EmbeddedWatermarkStatus {
    decode_watermark_bytes(
        &KEY_SHARE_A,
        &KEY_SHARE_B,
        &WATERMARK_NONCE,
        &ENCRYPTED_WATERMARK,
        WATERMARK_TAG,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_ciphertext_does_not_contain_plaintext_markers() {
        let joined = String::from_utf8_lossy(&ENCRYPTED_WATERMARK);
        assert!(!joined.contains("Aberuu"));
        assert!(!joined.contains("github.com"));
        assert!(!ENCRYPTED_WATERMARK.windows(6).any(|w| w == b"Aberuu"));
    }

    #[test]
    fn decrypts_formatted_watermark_and_github_links() {
        let status = verify_embedded_watermark();
        assert!(status.integrity_valid);
        assert_eq!(status.credit, "Developed by Aberuu");
        assert_eq!(status.author, "Aberuu");
        assert_eq!(status.github_profile_url, "https://github.com/Aberuu");
        assert_eq!(
            status.github_repo_url,
            "https://github.com/Aberuu/bitchord-dsk"
        );
        assert!(status.formatted.contains("BitChord Desktop (bitchord-dsk)"));
        assert!(status
            .formatted
            .contains("Credit     : Developed by Aberuu"));
        assert!(status
            .formatted
            .contains("Repository : https://github.com/Aberuu/bitchord-dsk"));
    }

    #[test]
    fn detects_single_bit_tampering_on_ciphertext_or_tag() {
        let mut tampered_cipher = ENCRYPTED_WATERMARK;
        tampered_cipher[12] ^= 0x01;
        let bad_cipher = decode_watermark_bytes(
            &KEY_SHARE_A,
            &KEY_SHARE_B,
            &WATERMARK_NONCE,
            &tampered_cipher,
            WATERMARK_TAG,
        );
        assert!(!bad_cipher.integrity_valid);
        assert!(bad_cipher.formatted.is_empty());

        let bad_tag = decode_watermark_bytes(
            &KEY_SHARE_A,
            &KEY_SHARE_B,
            &WATERMARK_NONCE,
            &ENCRYPTED_WATERMARK,
            WATERMARK_TAG ^ 0x01,
        );
        assert!(!bad_tag.integrity_valid);
        assert!(bad_tag.credit.is_empty());
    }
}
