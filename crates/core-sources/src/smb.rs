use crate::model::{
    codec_from_name, is_audio_file, is_image_file, pick_best_cover, split_artist_title,
    RemoteTrackItem,
};
use anyhow::{anyhow, Result};
use core_auth::StoredSmbConfig;
use futures_util::StreamExt;
use smb::{
    Client, ClientConfig, ConnectionConfig, CreateDisposition, CreateOptions, DirAccessMask,
    Directory, FileAccessMask, FileAttributes, FileCreateArgs, FileDirectoryInformation, GetLen,
    ReadAt, Resource, UncPath,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

const MAX_FILES: usize = 10_000;
const CONNECT_TIMEOUT_SECS: u64 = 12;

pub fn split_host_port(raw: &str) -> (String, u16) {
    let authority = raw
        .trim()
        .strip_prefix("smb://")
        .or_else(|| raw.trim().strip_prefix("\\\\"))
        .unwrap_or(raw.trim())
        .split(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();

    if authority.starts_with('[') {
        let host = authority
            .trim_start_matches('[')
            .split(']')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let port = authority
            .split("]:")
            .nth(1)
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|&p| p > 0)
            .unwrap_or(445);
        return (host, port);
    }

    if let Some((h, p)) = authority.rsplit_once(':') {
        if !h.is_empty() && !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) {
            let port = p.parse::<u16>().ok().filter(|&v| v > 0).unwrap_or(445);
            return (h.trim().to_ascii_lowercase(), port);
        }
    }

    (authority.to_ascii_lowercase(), 445)
}

pub fn normalize_base_path(raw: &str) -> String {
    raw.trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

pub fn is_configured(host: &str, share: &str) -> bool {
    let (h, _) = split_host_port(host);
    !h.is_empty() && !share.trim().trim_matches(['/', '\\']).is_empty()
}

fn dir_args() -> FileCreateArgs {
    FileCreateArgs {
        disposition: CreateDisposition::Open,
        attributes: FileAttributes::new(),
        options: CreateOptions::new().with_directory_file(true),
        desired_access: FileAccessMask::from(DirAccessMask::new().with_list_directory(true)),
    }
}

fn read_args() -> FileCreateArgs {
    FileCreateArgs::make_open_existing(FileAccessMask::new().with_generic_read(true))
}

async fn connect_client(config: &StoredSmbConfig) -> Result<(Client, UncPath)> {
    let (host, port) = split_host_port(&config.host);
    let share = config.share.trim().trim_matches(['/', '\\']);
    if host.is_empty() || share.is_empty() {
        return Err(anyhow!("Enter a server and a share"));
    }

    let mut cfg = ClientConfig::default();
    cfg.connection = ConnectionConfig {
        port: Some(port),
        timeout: Some(Duration::from_secs(CONNECT_TIMEOUT_SECS)),
        ..Default::default()
    };

    let client = Client::new(cfg);
    let unc = UncPath::new(&host)?.with_share(share)?;
    client
        .share_connect(&unc, config.username.trim(), config.password.clone())
        .await
        .map_err(|e| anyhow!("SMB connection failed: {e}"))?;
    Ok((client, unc))
}

async fn list_dir_entries(client: &Client, unc_root: &UncPath, rel_dir: &str) -> Result<Vec<(String, bool, u64)>> {
    let target = if rel_dir.is_empty() {
        unc_root.clone()
    } else {
        unc_root.clone().with_path(&rel_dir.replace('/', "\\"))
    };
    let res = client
        .create_file(&target, &dir_args())
        .await
        .map_err(|e| anyhow!("Cannot open SMB directory '{}': {e}", rel_dir))?;
    let Resource::Directory(dir) = res else {
        return Err(anyhow!("SMB path '{}' is not a directory", rel_dir));
    };
    let dir = Arc::new(dir);
    let mut entries = Vec::new();
    let mut stream = Directory::query::<FileDirectoryInformation>(&dir, "*").await?;
    while let Some(item) = stream.next().await {
        let info = item?;
        let name = info.file_name.to_string();
        if name == "." || name == ".." || name.is_empty() {
            continue;
        }
        entries.push((name, info.file_attributes.directory(), info.end_of_file));
    }
    Ok(entries)
}

pub async fn test_connection(config: &StoredSmbConfig) -> Result<()> {
    let (client, unc) = connect_client(config).await?;
    let base = normalize_base_path(&config.base_path);
    list_dir_entries(&client, &unc, &base).await?;
    Ok(())
}

pub async fn list_library(config: &StoredSmbConfig) -> Result<Vec<RemoteTrackItem>> {
    if !is_configured(&config.host, &config.share) {
        return Ok(Vec::new());
    }
    let (client, unc) = connect_client(config).await?;
    let base = normalize_base_path(&config.base_path);
    let (host, _) = split_host_port(&config.host);
    let share = config.share.trim().trim_matches(['/', '\\']).to_string();

    let mut queue = VecDeque::new();
    let mut visited = HashSet::new();
    queue.push_back(base.clone());

    let mut audio_files: Vec<(String, String, u64)> = Vec::new();
    let mut images_by_dir: HashMap<String, Vec<String>> = HashMap::new();

    while let Some(dir) = queue.pop_front() {
        if audio_files.len() >= MAX_FILES {
            break;
        }
        let key = dir.to_ascii_lowercase();
        if !visited.insert(key) {
            continue;
        }
        let entries = match list_dir_entries(&client, &unc, &dir).await {
            Ok(list) => list,
            Err(err) => {
                if visited.len() == 1 {
                    return Err(err);
                }
                tracing::debug!("Skipping SMB directory '{}': {err}", dir);
                continue;
            }
        };

        for (name, is_dir, size) in entries {
            let child_path = if dir.is_empty() {
                name.clone()
            } else {
                format!("{dir}/{name}")
            };
            if is_dir {
                if !visited.contains(&child_path.to_ascii_lowercase()) {
                    queue.push_back(child_path);
                }
            } else if is_audio_file(&name) {
                audio_files.push((child_path, name, size));
            } else if is_image_file(&name) {
                images_by_dir
                    .entry(dir.to_ascii_lowercase())
                    .or_default()
                    .push(child_path);
            }
        }
    }

    Ok(audio_files
        .into_iter()
        .map(|(rel_path, file_name, size_bytes)| {
            let dir_part = rel_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            let album = dir_part
                .rsplit('/')
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let (artist, title) = split_artist_title(&file_name);
            let art = images_by_dir
                .get(&dir_part.to_ascii_lowercase())
                .and_then(|imgs| pick_best_cover(imgs.iter().map(String::as_str)));
            RemoteTrackItem {
                id: format!("smb:{host}/{share}/{rel_path}"),
                source_kind: "smb".to_string(),
                title,
                artist,
                album,
                codec: codec_from_name(&file_name),
                file_name,
                size_bytes,
                rel_path,
                proxy_key: String::new(),
                stream_proxy_url: String::new(),
                artwork_proxy_url: art,
            }
        })
        .collect())
}

pub async fn read_smb_range(
    config: &StoredSmbConfig,
    rel_path: &str,
    start: u64,
    end_inclusive: Option<u64>,
) -> Result<(Vec<u8>, u64)> {
    let (client, unc) = connect_client(config).await?;
    let target = unc.with_path(&rel_path.trim_matches('/').replace('/', "\\"));
    let Resource::File(file) = client.create_file(&target, &read_args()).await? else {
        return Err(anyhow!("SMB target '{}' is not a file", rel_path));
    };
    let total = file.get_len().await?;
    if total == 0 || start >= total {
        let _ = file.close().await;
        return Ok((Vec::new(), total));
    }
    let end = end_inclusive.unwrap_or(total - 1).min(total - 1);
    let wanted = (end - start + 1) as usize;
    let mut buf = vec![0u8; wanted];
    let mut offset = 0usize;
    while offset < wanted {
        let chunk_len = (wanted - offset).min(1024 * 1024);
        let n = file
            .read_at(&mut buf[offset..offset + chunk_len], start + offset as u64)
            .await?;
        if n == 0 {
            break;
        }
        offset += n;
    }
    buf.truncate(offset);
    let _ = file.close().await;
    Ok((buf, total))
}

pub async fn read_smb_all_capped(
    config: &StoredSmbConfig,
    rel_path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>> {
    let (client, unc) = connect_client(config).await?;
    let target = unc.with_path(&rel_path.trim_matches('/').replace('/', "\\"));
    let Resource::File(file) = client.create_file(&target, &read_args()).await? else {
        return Err(anyhow!("SMB target '{}' is not a file", rel_path));
    };
    let total = file.get_len().await?;
    if total > max_bytes {
        let _ = file.close().await;
        return Err(anyhow!("SMB file exceeds {} MB limit", max_bytes / (1024 * 1024)));
    }
    let mut buf = vec![0u8; total as usize];
    let mut offset = 0usize;
    while offset < buf.len() {
        let chunk_len = (buf.len() - offset).min(1024 * 1024);
        let n = file.read_at(&mut buf[offset..offset + chunk_len], offset as u64).await?;
        if n == 0 {
            break;
        }
        offset += n;
    }
    buf.truncate(offset);
    let _ = file.close().await;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_hosts_and_ports() {
        assert_eq!(split_host_port("nas.local"), ("nas.local".to_string(), 445));
        assert_eq!(split_host_port("192.168.1.10:4445"), ("192.168.1.10".to_string(), 4445));
        assert_eq!(split_host_port("smb://fileserver.home/Music"), ("fileserver.home".to_string(), 445));
        assert_eq!(split_host_port("[::1]:4445"), ("::1".to_string(), 4445));
    }

    #[test]
    fn checks_configuration_requirements() {
        assert!(!is_configured("", "Music"));
        assert!(!is_configured("nas.local", ""));
        assert!(is_configured("nas.local", "Music"));
    }
}
