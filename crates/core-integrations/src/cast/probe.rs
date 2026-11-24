use crate::cast::types::CastSupportStatus;
use socket2::{Domain, Protocol, Socket, Type};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};

#[derive(Debug, Clone)]
pub struct LanAdapter {
    pub name: String,
    pub ip: Ipv4Addr,
    pub is_wireless: bool,
    pub score: i32,
}

fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_link_local() || ip.is_multicast() {
        return false;
    }
    true
}

fn score_adapter(name: &str, if_type: u32) -> i32 {
    let lower = name.to_ascii_lowercase();
    let virtual_keywords = [
        "loopback",
        "vethernet",
        "hyper-v",
        "wsl",
        "virtualbox",
        "vmware",
        "tailscale",
        "zerotier",
        "wireguard",
        "wintun",
        "teredo",
        "bluetooth",
        "tap-",
        "tun",
    ];
    if virtual_keywords.iter().any(|k| lower.contains(k)) {
        return -50;
    }
    match if_type {
        71 => 100, // IF_TYPE_IEEE80211 (Wi-Fi)
        6 => 80,   // IF_TYPE_ETHERNET_CSMACD (Ethernet)
        _ => 20,
    }
}

#[cfg(windows)]
pub fn list_active_lan_adapters() -> Vec<LanAdapter> {
    use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH, IF_TYPE_SOFTWARE_LOOPBACK,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u8> = vec![0u8; size as usize];

    unsafe {
        let mut status = GetAdaptersAddresses(
            AF_INET.0 as u32,
            flags,
            None,
            Some(buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
            &mut size,
        );
        if status == ERROR_BUFFER_OVERFLOW.0 {
            buf.resize(size as usize, 0);
            status = GetAdaptersAddresses(
                AF_INET.0 as u32,
                flags,
                None,
                Some(buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
                &mut size,
            );
        }
        if status != 0 || size == 0 {
            return Vec::new();
        }

        let mut adapters = Vec::new();
        let mut current = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !current.is_null() {
            let entry = &*current;
            // IfOperStatusUp == 1
            if entry.OperStatus.0 == 1 && entry.IfType != IF_TYPE_SOFTWARE_LOOPBACK {
                // Bit 4 of Anonymous2.Flags marks NO_MULTICAST in IP_ADAPTER_ADDRESSES_LH.
                let no_multicast = (entry.Anonymous2.Flags & 0x0010) != 0;
                if !no_multicast {
                    let friendly = if !entry.FriendlyName.is_null() {
                        entry.FriendlyName.to_string().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let desc = if !entry.Description.is_null() {
                        entry.Description.to_string().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let label = if !friendly.is_empty() { friendly } else { desc.clone() };
                    let score = score_adapter(&format!("{label} {desc}"), entry.IfType);
                    if score > 0 {
                        let mut uc = entry.FirstUnicastAddress;
                        while !uc.is_null() {
                            let addr_item = &*uc;
                            let sa = addr_item.Address.lpSockaddr;
                            if !sa.is_null() && (*sa).sa_family == AF_INET {
                                let sin = &*(sa as *const SOCKADDR_IN);
                                let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr));
                                if is_usable_lan_ipv4(ip) {
                                    adapters.push(LanAdapter {
                                        name: label.clone(),
                                        ip,
                                        is_wireless: entry.IfType == 71,
                                        score,
                                    });
                                }
                            }
                            uc = addr_item.Next;
                        }
                    }
                }
            }
            current = entry.Next;
        }
        adapters.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.cmp(&b.name)));
        adapters
    }
}

#[cfg(not(windows))]
pub fn list_active_lan_adapters() -> Vec<LanAdapter> {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else {
        return Vec::new();
    };
    if sock.connect("192.0.2.1:80").is_err() {
        return Vec::new();
    }
    match sock.local_addr() {
        Ok(SocketAddr::V4(v4)) if is_usable_lan_ipv4(*v4.ip()) => vec![LanAdapter {
            name: "LAN Interface".to_string(),
            ip: *v4.ip(),
            is_wireless: false,
            score: 80,
        }],
        _ => Vec::new(),
    }
}

fn verify_udp_multicast_socket(local_ip: Ipv4Addr) -> bool {
    let Ok(sock) = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) else {
        return false;
    };
    let _ = sock.set_reuse_address(true);
    if sock
        .bind(&SocketAddrV4::new(local_ip, 0).into())
        .is_err()
    {
        return false;
    }
    sock.set_multicast_if_v4(&local_ip).is_ok()
}

pub fn probe_cast_support() -> CastSupportStatus {
    let adapters = list_active_lan_adapters();
    let Some(primary) = adapters.first() else {
        return CastSupportStatus {
            supported: false,
            reason: Some("No active Wi-Fi or Ethernet LAN interface is available.".to_string()),
            local_ip: None,
            adapter_name: None,
            protocols: Vec::new(),
        };
    };

    if !verify_udp_multicast_socket(primary.ip) {
        return CastSupportStatus {
            supported: false,
            reason: Some("UDP multicast is blocked or unavailable on the active network adapter.".to_string()),
            local_ip: Some(primary.ip.to_string()),
            adapter_name: Some(primary.name.clone()),
            protocols: Vec::new(),
        };
    }

    CastSupportStatus {
        supported: true,
        reason: None,
        local_ip: Some(primary.ip.to_string()),
        adapter_name: Some(primary.name.clone()),
        protocols: vec!["chromecast".to_string(), "dlna".to_string()],
    }
}

pub fn best_local_ip_for_peer(peer_host: &str) -> Option<Ipv4Addr> {
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect((peer_host, 8009)).is_ok() {
            if let Ok(SocketAddr::V4(v4)) = sock.local_addr() {
                if is_usable_lan_ipv4(*v4.ip()) {
                    return Some(*v4.ip());
                }
            }
        }
    }
    list_active_lan_adapters().first().map(|a| a.ip)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_loopback_and_link_local_addresses() {
        assert!(!is_usable_lan_ipv4(Ipv4Addr::LOCALHOST));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::UNSPECIFIED));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(169, 254, 12, 5)));
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(192, 168, 1, 24)));
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(10, 0, 0, 15)));
    }

    #[test]
    fn scores_physical_wifi_and_ethernet_above_virtual_adapters() {
        assert!(score_adapter("Wi-Fi", 71) > score_adapter("Ethernet", 6));
        assert!(score_adapter("vEthernet (WSL)", 6) < 0);
        assert!(score_adapter("Tailscale", 6) < 0);
    }
}
