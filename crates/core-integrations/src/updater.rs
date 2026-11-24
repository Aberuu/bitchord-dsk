use anyhow::{anyhow, Context, Result};
use core_auth::DesktopPrefs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_MAJOR_PATCH_LAG: u32 = 3;
pub const DEFAULT_GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/Aberuu/bitchord-dsk/releases?per_page=30";
pub const DEFAULT_RELEASE_PAGE_URL: &str = "https://github.com/Aberuu/bitchord-dsk/releases";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub prerelease: Option<String>,
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.prerelease, &other.prerelease) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => compare_prerelease(a, b),
            })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let mut parts_a = a.split('.');
    let mut parts_b = b.split('.');
    loop {
        match (parts_a.next(), parts_b.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(pa), Some(pb)) => {
                let ord = match (pa.parse::<u64>(), pb.parse::<u64>()) {
                    (Ok(na), Ok(nb)) => na.cmp(&nb),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => pa.cmp(pb),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

pub fn parse_semver(raw: &str) -> Option<SemVer> {
    let cleaned = raw.trim().trim_start_matches(['v', 'V']);
    if cleaned.is_empty() {
        return None;
    }
    let without_build = cleaned.split('+').next().unwrap_or(cleaned);
    let (core, prerelease) = match without_build.split_once('-') {
        Some((c, pre)) if !pre.trim().is_empty() => (c, Some(pre.trim().to_string())),
        Some((c, _)) => (c, None),
        None => (without_build, None),
    };
    let mut nums = core.split('.');
    let major = nums.next()?.parse::<u32>().ok()?;
    let minor = nums.next()?.parse::<u32>().ok()?;
    let patch = match nums.next() {
        Some(p) => p.parse::<u32>().ok()?,
        None => 0,
    };
    if nums.next().is_some() {
        return None;
    }
    Some(SemVer {
        major,
        minor,
        patch,
        prerelease,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub status: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub major_patch_lag: u32,
    pub max_major_patch_lag: u32,
    pub mandatory: bool,
    pub release_url: Option<String>,
    pub installer_url: Option<String>,
    pub installer_sha256: Option<String>,
    pub installer_file_name: Option<String>,
    pub downloaded_path: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterPrefsPayload {
    pub auto_check_updates: bool,
    pub auto_download_updates: bool,
    pub update_feed_url: Option<String>,
    pub skipped_version: Option<String>,
}

impl From<&DesktopPrefs> for UpdaterPrefsPayload {
    fn from(prefs: &DesktopPrefs) -> Self {
        Self {
            auto_check_updates: prefs.auto_check_updates,
            auto_download_updates: prefs.auto_download_updates,
            update_feed_url: prefs.update_feed_url.clone(),
            skipped_version: prefs.skipped_version.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub phase: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAssetItem {
    pub name: String,
    pub download_url: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseItem {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub html_url: Option<String>,
    pub body: Option<String>,
    pub assets: Vec<ReleaseAssetItem>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomFeedEntry {
    version: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    release_url: Option<String>,
    #[serde(default)]
    installer_url: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomFeedEnvelope {
    #[serde(default)]
    releases: Vec<CustomFeedEntry>,
}

fn normalize_sha256(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    let hex_part = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed)
        .trim();
    if hex_part.len() == 64 && hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hex_part.to_ascii_lowercase())
    } else {
        None
    }
}

fn custom_entry_to_release(entry: CustomFeedEntry) -> ReleaseItem {
    let mut assets = Vec::new();
    if let Some(url) = entry.installer_url.filter(|u| !u.trim().is_empty()) {
        let name = entry
            .file_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| infer_filename_from_url(&url, &entry.version));
        assets.push(ReleaseAssetItem {
            name,
            download_url: url,
            sha256: normalize_sha256(entry.sha256.as_deref()),
        });
    }
    ReleaseItem {
        tag_name: entry.version,
        draft: entry.draft,
        prerelease: entry.prerelease,
        html_url: entry.release_url,
        body: entry.notes,
        assets,
    }
}

fn infer_filename_from_url(url: &str, version: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(seg) = parsed.path_segments().and_then(|mut s| s.next_back()) {
            let clean = sanitize_installer_name(seg);
            if !clean.is_empty() {
                return clean;
            }
        }
    }
    let clean_ver = version.trim_start_matches(['v', 'V']);
    format!("BitChord-{clean_ver}-setup.exe")
}

pub fn sanitize_installer_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let filtered: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if filtered.is_empty() || filtered == "." || filtered == ".." {
        "bitchord-update-setup.exe".to_string()
    } else {
        filtered
    }
}

pub fn parse_release_feed_json(raw: &str) -> Result<Vec<ReleaseItem>> {
    let trimmed = raw.trim();
    if trimmed.starts_with('[') {
        let gh = serde_json::from_str::<Vec<GithubRelease>>(trimmed)
            .context("Failed to parse GitHub releases JSON array")?;
        return Ok(gh
            .into_iter()
            .map(|r| ReleaseItem {
                tag_name: r.tag_name,
                draft: r.draft,
                prerelease: r.prerelease,
                html_url: r.html_url,
                body: r.body,
                assets: r
                    .assets
                    .into_iter()
                    .map(|a| ReleaseAssetItem {
                        name: a.name,
                        download_url: a.browser_download_url,
                        sha256: normalize_sha256(a.digest.as_deref()),
                    })
                    .collect(),
            })
            .collect());
    }

    if let Ok(envelope) = serde_json::from_str::<CustomFeedEnvelope>(trimmed) {
        if !envelope.releases.is_empty() {
            return Ok(envelope
                .releases
                .into_iter()
                .map(custom_entry_to_release)
                .collect());
        }
    }

    if let Ok(single_custom) = serde_json::from_str::<CustomFeedEntry>(trimmed) {
        return Ok(vec![custom_entry_to_release(single_custom)]);
    }

    if let Ok(single_gh) = serde_json::from_str::<GithubRelease>(trimmed) {
        return Ok(vec![ReleaseItem {
            tag_name: single_gh.tag_name,
            draft: single_gh.draft,
            prerelease: single_gh.prerelease,
            html_url: single_gh.html_url,
            body: single_gh.body,
            assets: single_gh
                .assets
                .into_iter()
                .map(|a| ReleaseAssetItem {
                    name: a.name,
                    download_url: a.browser_download_url,
                    sha256: normalize_sha256(a.digest.as_deref()),
                })
                .collect(),
        }]);
    }

    Err(anyhow!("Unrecognized update release feed JSON format"))
}

pub fn select_windows_installer(assets: &[ReleaseAssetItem]) -> Option<&ReleaseAssetItem> {
    let mut ranked: Vec<(i32, &ReleaseAssetItem)> = assets
        .iter()
        .filter_map(|asset| {
            let lower = asset.name.to_ascii_lowercase();
            if lower.ends_with(".sig") || lower.ends_with(".sha256") || lower.ends_with(".txt") {
                return None;
            }
            if lower.ends_with(".exe") {
                let score = if lower.contains("setup") && lower.contains("x64") {
                    100
                } else if lower.contains("setup") {
                    90
                } else if lower.contains("x64") {
                    80
                } else {
                    70
                };
                Some((score, asset))
            } else if lower.ends_with(".msi") {
                let score = if lower.contains("x64") { 85 } else { 75 };
                Some((score, asset))
            } else {
                None
            }
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    ranked.first().map(|(_, asset)| *asset)
}

pub fn find_checksum_asset<'a>(
    assets: &'a [ReleaseAssetItem],
    installer_name: &str,
) -> Option<&'a ReleaseAssetItem> {
    let target_sha = format!("{}.sha256", installer_name.to_ascii_lowercase());
    assets.iter().find(|asset| {
        let lower = asset.name.to_ascii_lowercase();
        lower == target_sha || lower == "sha256sums" || lower == "sha256sums.txt"
    })
}

pub fn parse_sha256_from_checksum_text(text: &str, installer_name: &str) -> Option<String> {
    let target_lower = installer_name.to_ascii_lowercase();
    let mut first_valid: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(hash_token) = parts.next() else {
            continue;
        };
        let Some(valid_hash) = normalize_sha256(Some(hash_token)) else {
            continue;
        };
        if first_valid.is_none() {
            first_valid = Some(valid_hash.clone());
        }
        if let Some(rest) = parts.next() {
            let file_token = rest.trim_start_matches('*').to_ascii_lowercase();
            if file_token == target_lower || file_token.ends_with(&format!("/{target_lower}")) {
                return Some(valid_hash);
            }
        }
    }
    first_valid
}

pub fn updates_dir() -> PathBuf {
    core_auth::vault::app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("BitChord"))
        .join("updates")
}

pub fn compute_file_sha256(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("Failed to read {}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

pub fn evaluate_releases(
    current_version: &str,
    releases: &[ReleaseItem],
    downloaded_dir: Option<&Path>,
) -> UpdateCheckResult {
    let Some(current_ver) = parse_semver(current_version) else {
        return UpdateCheckResult {
            status: "error".into(),
            current_version: current_version.to_string(),
            latest_version: None,
            major_patch_lag: 0,
            max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
            mandatory: false,
            release_url: Some(DEFAULT_RELEASE_PAGE_URL.into()),
            installer_url: None,
            installer_sha256: None,
            installer_file_name: None,
            downloaded_path: None,
            notes: Some(format!("Invalid current version string: {current_version}")),
        };
    };

    let allow_prerelease = current_ver.prerelease.is_some();
    let mut parsed: Vec<(SemVer, &ReleaseItem)> = releases
        .iter()
        .filter(|rel| !rel.draft && (allow_prerelease || !rel.prerelease))
        .filter_map(|rel| parse_semver(&rel.tag_name).map(|ver| (ver, rel)))
        .collect();

    parsed.sort_by(|a, b| a.0.cmp(&b.0));

    let Some((latest_ver, latest_rel)) = parsed.last().cloned() else {
        return UpdateCheckResult {
            status: "up_to_date".into(),
            current_version: current_version.to_string(),
            latest_version: None,
            major_patch_lag: 0,
            max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
            mandatory: false,
            release_url: Some(DEFAULT_RELEASE_PAGE_URL.into()),
            installer_url: None,
            installer_sha256: None,
            installer_file_name: None,
            downloaded_path: None,
            notes: Some("No published releases found on the configured feed.".into()),
        };
    };

    if latest_ver <= current_ver {
        return UpdateCheckResult {
            status: "up_to_date".into(),
            current_version: current_version.to_string(),
            latest_version: Some(latest_rel.tag_name.trim_start_matches(['v', 'V']).to_string()),
            major_patch_lag: 0,
            max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
            mandatory: false,
            release_url: latest_rel
                .html_url
                .clone()
                .or_else(|| Some(DEFAULT_RELEASE_PAGE_URL.into())),
            installer_url: None,
            installer_sha256: None,
            installer_file_name: None,
            downloaded_path: None,
            notes: Some("BitChord Desktop is up to date.".into()),
        };
    }

    let cur_milestone = (current_ver.major, current_ver.minor);
    let latest_milestone = (latest_ver.major, latest_ver.minor);
    let major_patch_lag = if latest_milestone <= cur_milestone {
        0
    } else if parsed.len() == 1 {
        if latest_ver.major == current_ver.major {
            latest_ver.minor.saturating_sub(current_ver.minor)
        } else {
            latest_ver
                .major
                .saturating_sub(current_ver.major)
                .saturating_add(latest_ver.minor)
        }
    } else {
        let milestones: BTreeSet<(u32, u32)> = parsed
            .iter()
            .map(|(v, _)| (v.major, v.minor))
            .filter(|m| *m > cur_milestone && *m <= latest_milestone)
            .collect();
        milestones.len() as u32
    };

    let mandatory = major_patch_lag > MAX_MAJOR_PATCH_LAG;
    let installer = select_windows_installer(&latest_rel.assets);
    let installer_file_name = installer.map(|a| sanitize_installer_name(&a.name));
    let installer_url = installer.map(|a| a.download_url.clone());
    let installer_sha256 = installer.and_then(|a| a.sha256.clone());

    let downloaded_path = downloaded_dir.and_then(|dir| {
        let name = installer_file_name.as_deref()?;
        let candidate = dir.join(name);
        if !candidate.is_file() {
            return None;
        }
        if let Some(expected) = installer_sha256.as_deref() {
            let actual = compute_file_sha256(&candidate).ok()?;
            if actual != expected {
                return None;
            }
        }
        Some(candidate.to_string_lossy().to_string())
    });

    let status = if mandatory {
        "mandatory"
    } else if downloaded_path.is_some() {
        "downloaded"
    } else {
        "available"
    };

    UpdateCheckResult {
        status: status.into(),
        current_version: current_version.to_string(),
        latest_version: Some(latest_rel.tag_name.trim_start_matches(['v', 'V']).to_string()),
        major_patch_lag,
        max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
        mandatory,
        release_url: latest_rel
            .html_url
            .clone()
            .or_else(|| Some(DEFAULT_RELEASE_PAGE_URL.into())),
        installer_url,
        installer_sha256,
        installer_file_name,
        downloaded_path,
        notes: latest_rel.body.clone(),
    }
}

pub async fn fetch_releases_and_evaluate(
    http: &reqwest::Client,
    current_version: &str,
    feed_url: Option<&str>,
) -> UpdateCheckResult {
    let target_url = feed_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_GITHUB_RELEASES_URL);

    let resp = match http
        .get(target_url)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            return UpdateCheckResult {
                status: "error".into(),
                current_version: current_version.to_string(),
                latest_version: None,
                major_patch_lag: 0,
                max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
                mandatory: false,
                release_url: Some(DEFAULT_RELEASE_PAGE_URL.into()),
                installer_url: None,
                installer_sha256: None,
                installer_file_name: None,
                downloaded_path: None,
                notes: Some(format!("Unable to reach update server: {err}")),
            };
        }
    };

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let detail = if code == 404 {
            "No published GitHub releases yet for Aberuu/bitchord-dsk.".to_string()
        } else {
            format!("Update feed returned HTTP {code}.")
        };
        return UpdateCheckResult {
            status: if code == 404 { "up_to_date" } else { "error" }.into(),
            current_version: current_version.to_string(),
            latest_version: None,
            major_patch_lag: 0,
            max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
            mandatory: false,
            release_url: Some(DEFAULT_RELEASE_PAGE_URL.into()),
            installer_url: None,
            installer_sha256: None,
            installer_file_name: None,
            downloaded_path: None,
            notes: Some(detail),
        };
    }

    let body = match resp.text().await {
        Ok(b) => b,
        Err(err) => {
            return UpdateCheckResult {
                status: "error".into(),
                current_version: current_version.to_string(),
                latest_version: None,
                major_patch_lag: 0,
                max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
                mandatory: false,
                release_url: Some(DEFAULT_RELEASE_PAGE_URL.into()),
                installer_url: None,
                installer_sha256: None,
                installer_file_name: None,
                downloaded_path: None,
                notes: Some(format!("Failed reading update feed body: {err}")),
            };
        }
    };

    let mut releases = match parse_release_feed_json(&body) {
        Ok(list) => list,
        Err(err) => {
            return UpdateCheckResult {
                status: "error".into(),
                current_version: current_version.to_string(),
                latest_version: None,
                major_patch_lag: 0,
                max_major_patch_lag: MAX_MAJOR_PATCH_LAG,
                mandatory: false,
                release_url: Some(DEFAULT_RELEASE_PAGE_URL.into()),
                installer_url: None,
                installer_sha256: None,
                installer_file_name: None,
                downloaded_path: None,
                notes: Some(err.to_string()),
            };
        }
    };

    // Hydrate SHA-256 from sibling .sha256 or SHA256SUMS asset when not provided inline.
    let initial = evaluate_releases(current_version, &releases, None);
    if initial.installer_sha256.is_none() {
        if let (Some(latest_tag), Some(file_name)) =
            (initial.latest_version.as_deref(), initial.installer_file_name.as_deref())
        {
            if let Some(rel) = releases
                .iter_mut()
                .find(|r| r.tag_name.trim_start_matches(['v', 'V']) == latest_tag)
            {
                let checksum_url = find_checksum_asset(&rel.assets, file_name)
                    .map(|a| a.download_url.clone());
                if let Some(url) = checksum_url {
                    if let Ok(r) = http
                        .get(&url)
                        .timeout(std::time::Duration::from_secs(8))
                        .send()
                        .await
                    {
                        if r.status().is_success() {
                            if let Ok(txt) = r.text().await {
                                if let Some(hash) = parse_sha256_from_checksum_text(&txt, file_name)
                                {
                                    for asset in &mut rel.assets {
                                        if sanitize_installer_name(&asset.name) == file_name {
                                            asset.sha256 = Some(hash.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let dir = updates_dir();
    evaluate_releases(current_version, &releases, Some(&dir))
}

pub async fn download_installer<F>(
    http: &reqwest::Client,
    installer_url: &str,
    file_name: Option<&str>,
    expected_sha256: Option<&str>,
    mut on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(UpdateDownloadProgress),
{
    let parsed_url = url::Url::parse(installer_url).context("Invalid installer URL")?;
    if !matches!(parsed_url.scheme(), "https" | "http") {
        return Err(anyhow!("Installer URL must use http or https"));
    }

    let clean_name = sanitize_installer_name(
        file_name.unwrap_or_else(|| {
            parsed_url
                .path_segments()
                .and_then(|mut s| s.next_back())
                .unwrap_or("bitchord-update-setup.exe")
        }),
    );
    let lower = clean_name.to_ascii_lowercase();
    if !(lower.ends_with(".exe") || lower.ends_with(".msi")) {
        return Err(anyhow!(
            "Unsupported installer filename (expected .exe or .msi): {clean_name}"
        ));
    }

    let dir = updates_dir();
    fs::create_dir_all(&dir).context("Failed to create updates directory")?;
    let final_path = dir.join(&clean_name);
    let part_path = dir.join(format!("{clean_name}.part"));

    let expected_norm = normalize_sha256(expected_sha256);

    // Reuse already verified file if present.
    if final_path.is_file() {
        if let Some(expected) = expected_norm.as_deref() {
            if let Ok(actual) = compute_file_sha256(&final_path) {
                if actual == expected {
                    on_progress(UpdateDownloadProgress {
                        received_bytes: fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0),
                        total_bytes: fs::metadata(&final_path).ok().map(|m| m.len()),
                        phase: "ready".into(),
                        message: Some("Update already downloaded and verified.".into()),
                    });
                    return Ok(final_path);
                }
            }
        }
    }

    let mut resp = http
        .get(installer_url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .context("Failed to start installer download")?;

    if !resp.status().is_success() {
        return Err(anyhow!(
            "Installer download failed with HTTP {}",
            resp.status().as_u16()
        ));
    }

    let total_bytes = resp.content_length();
    let mut file = fs::File::create(&part_path).context("Failed to create temporary update file")?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;

    on_progress(UpdateDownloadProgress {
        received_bytes: 0,
        total_bytes,
        phase: "downloading".into(),
        message: None,
    });

    while let Some(chunk) = resp.chunk().await.context("Download interrupted")? {
        file.write_all(&chunk).context("Failed writing update chunk")?;
        hasher.update(&chunk);
        received = received.saturating_add(chunk.len() as u64);
        on_progress(UpdateDownloadProgress {
            received_bytes: received,
            total_bytes,
            phase: "downloading".into(),
            message: None,
        });
    }
    file.flush().context("Failed flushing update file")?;
    drop(file);

    on_progress(UpdateDownloadProgress {
        received_bytes: received,
        total_bytes,
        phase: "verifying".into(),
        message: Some("Verifying installer integrity...".into()),
    });

    let actual_sha = hex::encode(hasher.finalize());
    if let Some(expected) = expected_norm.as_deref() {
        if actual_sha != expected {
            let _ = fs::remove_file(&part_path);
            return Err(anyhow!(
                "SHA-256 verification failed (expected {expected}, got {actual_sha})"
            ));
        }
    }

    let _ = fs::remove_file(&final_path);
    fs::rename(&part_path, &final_path).context("Failed finalizing downloaded installer")?;

    on_progress(UpdateDownloadProgress {
        received_bytes: received,
        total_bytes: Some(received),
        phase: "ready".into(),
        message: Some("Update verified and ready to install.".into()),
    });

    Ok(final_path)
}

pub fn launch_downloaded_installer(path: &Path) -> Result<()> {
    let dir = updates_dir();
    let canonical_dir = fs::canonicalize(&dir).unwrap_or(dir);
    let canonical_file = fs::canonicalize(path)
        .with_context(|| format!("Downloaded installer not found at {}", path.display()))?;

    if !canonical_file.starts_with(&canonical_dir) {
        return Err(anyhow!(
            "Refusing to execute installer outside BitChord updates folder"
        ));
    }

    let lower = canonical_file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !(lower.ends_with(".exe") || lower.ends_with(".msi")) {
        return Err(anyhow!("Installer must be a Windows .exe or .msi package"));
    }

    #[cfg(target_os = "windows")]
    {
        if lower.ends_with(".msi") {
            std::process::Command::new("msiexec")
                .arg("/i")
                .arg(&canonical_file)
                .spawn()
                .context("Failed to launch Windows MSI installer")?;
        } else {
            std::process::Command::new(&canonical_file)
                .spawn()
                .context("Failed to launch Windows setup executable")?;
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow!(
            "Direct installer launch is only supported on Windows"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_release(tag: &str, exe: Option<&str>, sha: Option<&str>) -> ReleaseItem {
        let mut assets = Vec::new();
        if let Some(name) = exe {
            assets.push(ReleaseAssetItem {
                name: name.to_string(),
                download_url: format!("https://example.invalid/downloads/{name}"),
                sha256: sha.map(|s| s.to_string()),
            });
        }
        ReleaseItem {
            tag_name: tag.to_string(),
            draft: false,
            prerelease: tag.contains('-'),
            html_url: Some(format!("https://example.invalid/releases/{tag}")),
            body: Some(format!("Notes for {tag}")),
            assets,
        }
    }

    #[test]
    fn semver_parses_and_orders_prerelease_and_stable() {
        let beta = parse_semver("v0.8.0-beta.808").expect("parse beta");
        let beta_next = parse_semver("0.8.0-beta.809").expect("parse beta next");
        let stable = parse_semver("v0.8.0").expect("parse stable");
        let next_minor = parse_semver("0.9.0").expect("parse minor");

        assert!(beta < beta_next);
        assert!(beta_next < stable);
        assert!(stable < next_minor);
    }

    #[test]
    fn enforces_max_three_major_or_minor_patch_lag_and_ignores_hotfixes() {
        // 5 hotfixes within 0.8.x should NEVER trigger mandatory lock.
        let hotfixes = vec![
            mk_release("v0.8.1", Some("BitChord-0.8.1-x64-setup.exe"), None),
            mk_release("v0.8.2", Some("BitChord-0.8.2-x64-setup.exe"), None),
            mk_release("v0.8.3", Some("BitChord-0.8.3-x64-setup.exe"), None),
            mk_release("v0.8.4", Some("BitChord-0.8.4-x64-setup.exe"), None),
            mk_release("v0.8.5", Some("BitChord-0.8.5-x64-setup.exe"), None),
        ];
        let res_hotfix = evaluate_releases("0.8.0", &hotfixes, None);
        assert_eq!(res_hotfix.status, "available");
        assert_eq!(res_hotfix.major_patch_lag, 0);
        assert!(!res_hotfix.mandatory);

        // Exactly 3 major/minor patches behind (0.9, 0.10, 0.11): allowed (optional auto-update).
        let three_behind = vec![
            mk_release("v0.9.0", Some("BitChord-0.9.0-x64-setup.exe"), None),
            mk_release("v0.10.0", Some("BitChord-0.10.0-x64-setup.exe"), None),
            mk_release("v0.11.0", Some("BitChord-0.11.0-x64-setup.exe"), None),
        ];
        let res_three = evaluate_releases("0.8.0-beta.808", &three_behind, None);
        assert_eq!(res_three.status, "available");
        assert_eq!(res_three.major_patch_lag, 3);
        assert!(!res_three.mandatory);
        assert_eq!(res_three.latest_version.as_deref(), Some("0.11.0"));

        // 4 major/minor patches behind (0.9, 0.10, 0.11, 0.12): mandatory lock!
        let four_behind = vec![
            mk_release("v0.9.0", Some("BitChord-0.9.0-x64-setup.exe"), None),
            mk_release("v0.10.1", Some("BitChord-0.10.1-x64-setup.exe"), None),
            mk_release("v0.11.0", Some("BitChord-0.11.0-x64-setup.exe"), None),
            mk_release("v0.12.0", Some("BitChord-0.12.0-x64-setup.exe"), None),
        ];
        let res_four = evaluate_releases("0.8.0", &four_behind, None);
        assert_eq!(res_four.status, "mandatory");
        assert_eq!(res_four.major_patch_lag, 4);
        assert!(res_four.mandatory);
        assert_eq!(
            res_four.installer_file_name.as_deref(),
            Some("BitChord-0.12.0-x64-setup.exe")
        );

        // Single-entry manifest fallback with version jump 0.8.0 -> 0.12.0 calculates numeric lag 4.
        let single_jump = vec![mk_release("v0.12.0", Some("BitChord-0.12.0.msi"), None)];
        let res_single = evaluate_releases("0.8.0", &single_jump, None);
        assert_eq!(res_single.major_patch_lag, 4);
        assert!(res_single.mandatory);
    }

    #[test]
    fn parses_github_and_custom_feeds_and_checksums() {
        let custom_json = r#"{
            "releases": [
                {
                    "version": "0.12.0",
                    "releaseUrl": "https://example.test/r/0.12.0",
                    "installerUrl": "https://example.test/BitChord-0.12.0-x64-setup.exe",
                    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "notes": "Major release"
                }
            ]
        }"#;
        let parsed = parse_release_feed_json(custom_json).expect("parse custom feed");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].assets[0].name, "BitChord-0.12.0-x64-setup.exe");

        let sums = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  other.zip\n\
                    cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc *BitChord-0.12.0-x64-setup.exe\n";
        assert_eq!(
            parse_sha256_from_checksum_text(sums, "BitChord-0.12.0-x64-setup.exe").as_deref(),
            Some("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
        );
    }
}
