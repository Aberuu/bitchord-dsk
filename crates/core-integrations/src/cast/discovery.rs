use crate::cast::probe::list_active_lan_adapters;
use crate::cast::types::{CastDevice, CastProtocol};
use anyhow::{anyhow, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;
use tokio::net::UdpSocket;
use url::Url;

const MDNS_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;
const SSDP_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;

pub async fn discover_all_devices(http: &reqwest::Client, timeout_ms: u64) -> Vec<CastDevice> {
    let adapters = list_active_lan_adapters();
    if adapters.is_empty() {
        return Vec::new();
    }
    let window = Duration::from_millis(timeout_ms.clamp(1200, 6000));
    let (mdns_devices, dlna_devices) = tokio::join!(
        discover_chromecast(&adapters, window),
        discover_dlna(http, &adapters, window)
    );

    let mut merged: HashMap<String, CastDevice> = HashMap::new();
    for dev in mdns_devices.into_iter().chain(dlna_devices.into_iter()) {
        merged.entry(dev.id.clone()).or_insert(dev);
    }
    let mut list: Vec<CastDevice> = merged.into_values().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

fn bind_multicast_udp(local_ip: Ipv4Addr) -> Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    sock.set_nonblocking(true)?;
    sock.bind(&SocketAddrV4::new(local_ip, 0).into())?;
    sock.set_multicast_if_v4(&local_ip)?;
    let _ = sock.set_multicast_ttl_v4(4);
    let std_sock: std::net::UdpSocket = sock.into();
    Ok(UdpSocket::from_std(std_sock)?)
}

fn bind_mdns_multicast_listener(adapters: &[crate::cast::probe::LanAdapter]) -> Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    sock.set_nonblocking(true)?;
    sock.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT).into())?;
    let mut joined = false;
    for adapter in adapters.iter().take(4) {
        if sock.join_multicast_v4(&MDNS_ADDR, &adapter.ip).is_ok() {
            joined = true;
        }
    }
    if !joined {
        sock.join_multicast_v4(&MDNS_ADDR, &Ipv4Addr::UNSPECIFIED)?;
    }
    let std_sock: std::net::UdpSocket = sock.into();
    Ok(UdpSocket::from_std(std_sock)?)
}

fn build_mdns_ptr_query_with_mode(service_name: &str, unicast_response: bool) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(64);
    // Transaction ID=0, Flags=0 (standard query), QDCOUNT=1
    pkt.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    for label in service_name.trim_end_matches('.').split('.') {
        let bytes = label.as_bytes();
        pkt.push(bytes.len() as u8);
        pkt.extend_from_slice(bytes);
    }
    pkt.push(0x00);
    // QTYPE = PTR (12), QCLASS = IN (0x0001 QM or 0x8001 QU)
    let qclass: u16 = if unicast_response { 0x8001 } else { 0x0001 };
    pkt.extend_from_slice(&[0x00, 0x0C]);
    pkt.extend_from_slice(&qclass.to_be_bytes());
    pkt
}

#[derive(Default)]
struct MdnsAccum {
    ptrs: Vec<String>,
    srvs: HashMap<String, (u16, String)>,
    txts: HashMap<String, HashMap<String, String>>,
    hosts_a: HashMap<String, Ipv4Addr>,
}

fn read_dns_name(pkt: &[u8], mut offset: usize) -> Option<(String, usize)> {
    let mut labels = Vec::new();
    let mut jumped = false;
    let mut end_offset = 0;
    let mut steps = 0;

    while offset < pkt.len() && steps < 64 {
        steps += 1;
        let len = pkt[offset];
        if len == 0 {
            if !jumped {
                end_offset = offset + 1;
            }
            return Some((labels.join("."), end_offset));
        }
        if (len & 0xC0) == 0xC0 {
            if offset + 1 >= pkt.len() {
                return None;
            }
            let ptr = (((len & 0x3F) as usize) << 8) | (pkt[offset + 1] as usize);
            if !jumped {
                end_offset = offset + 2;
                jumped = true;
            }
            offset = ptr;
            continue;
        }
        let next = offset + 1 + (len as usize);
        if next > pkt.len() {
            return None;
        }
        labels.push(String::from_utf8_lossy(&pkt[offset + 1..next]).into_owned());
        offset = next;
    }
    None
}

fn parse_txt_record(rdata: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut idx = 0;
    while idx < rdata.len() {
        let len = rdata[idx] as usize;
        idx += 1;
        if idx + len > rdata.len() {
            break;
        }
        let item = String::from_utf8_lossy(&rdata[idx..idx + len]);
        if let Some((k, v)) = item.split_once('=') {
            out.insert(k.to_string(), v.to_string());
        }
        idx += len;
    }
    out
}

fn ingest_mdns_packet(pkt: &[u8], accum: &mut MdnsAccum) {
    if pkt.len() < 12 {
        return;
    }
    let qdcount = u16::from_be_bytes([pkt[4], pkt[5]]) as usize;
    let ancount = u16::from_be_bytes([pkt[6], pkt[7]]) as usize;
    let nscount = u16::from_be_bytes([pkt[8], pkt[9]]) as usize;
    let arcount = u16::from_be_bytes([pkt[10], pkt[11]]) as usize;

    let mut pos = 12;
    for _ in 0..qdcount {
        let Some((_, next)) = read_dns_name(pkt, pos) else {
            return;
        };
        if next + 4 > pkt.len() {
            return;
        }
        pos = next + 4;
    }

    let total_rr = ancount + nscount + arcount;
    for _ in 0..total_rr {
        let Some((name, next)) = read_dns_name(pkt, pos) else {
            return;
        };
        if next + 10 > pkt.len() {
            return;
        }
        let rtype = u16::from_be_bytes([pkt[next], pkt[next + 1]]);
        let rdlength = u16::from_be_bytes([pkt[next + 8], pkt[next + 9]]) as usize;
        let rdata_start = next + 10;
        let rdata_end = rdata_start + rdlength;
        if rdata_end > pkt.len() {
            return;
        }
        let rdata = &pkt[rdata_start..rdata_end];
        let key = name.trim_end_matches('.').to_ascii_lowercase();

        match rtype {
            12 => {
                // PTR
                if let Some((target, _)) = read_dns_name(pkt, rdata_start) {
                    accum.ptrs.push(target.trim_end_matches('.').to_string());
                }
            }
            33 if rdata.len() >= 6 => {
                // SRV
                let port = u16::from_be_bytes([rdata[4], rdata[5]]);
                if let Some((target, _)) = read_dns_name(pkt, rdata_start + 6) {
                    accum
                        .srvs
                        .insert(key, (port, target.trim_end_matches('.').to_ascii_lowercase()));
                }
            }
            16 => {
                // TXT
                accum.txts.insert(key, parse_txt_record(rdata));
            }
            1 if rdata.len() == 4 => {
                // A
                accum
                    .hosts_a
                    .insert(key, Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]));
            }
            _ => {}
        }

        pos = rdata_end;
    }
}

fn assemble_chromecast_devices(accum: &MdnsAccum) -> Vec<CastDevice> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for instance in &accum.ptrs {
        let inst_lower = instance.to_ascii_lowercase();
        let Some(&(port, ref target)) = accum.srvs.get(&inst_lower) else {
            continue;
        };
        let Some(ip) = accum.hosts_a.get(target) else {
            continue;
        };
        let txt = accum.txts.get(&inst_lower);
        let id = txt
            .and_then(|t| t.get("id"))
            .cloned()
            .unwrap_or_else(|| format!("cast:{ip}:{port}"));
        if !seen.insert(id.clone()) {
            continue;
        }
        let fallback_name = instance
            .split('.')
            .next()
            .unwrap_or("Chromecast")
            .to_string();
        let name = txt
            .and_then(|t| t.get("fn"))
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .unwrap_or(fallback_name);
        let model = txt.and_then(|t| t.get("md")).cloned();

        out.push(CastDevice {
            id: format!("chromecast:{id}"),
            name,
            model,
            manufacturer: Some("Google Cast".to_string()),
            protocol: CastProtocol::Chromecast,
            host: ip.to_string(),
            port,
            av_transport_url: None,
            rendering_control_url: None,
        });
    }
    out
}

async fn discover_chromecast(
    adapters: &[crate::cast::probe::LanAdapter],
    window: Duration,
) -> Vec<CastDevice> {
    let mut send_sockets = Vec::new();
    for adapter in adapters.iter().take(4) {
        if let Ok(sock) = bind_multicast_udp(adapter.ip) {
            send_sockets.push(std::sync::Arc::new(sock));
        }
    }
    if send_sockets.is_empty() {
        return Vec::new();
    }

    let query_qu = build_mdns_ptr_query_with_mode("_googlecast._tcp.local.", true);
    let query_qm = build_mdns_ptr_query_with_mode("_googlecast._tcp.local.", false);
    let target = SocketAddr::V4(SocketAddrV4::new(MDNS_ADDR, MDNS_PORT));

    let mut listen_sockets = send_sockets.clone();
    if let Ok(mcast_sock) = bind_mdns_multicast_listener(adapters) {
        listen_sockets.push(std::sync::Arc::new(mcast_sock));
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
    let mut reader_tasks = Vec::with_capacity(listen_sockets.len());
    for sock in listen_sockets {
        let tx_c = tx.clone();
        reader_tasks.push(tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok((len, _)) = sock.recv_from(&mut buf).await {
                if tx_c.send(buf[..len].to_vec()).await.is_err() {
                    break;
                }
            }
        }));
    }
    drop(tx);

    for sock in &send_sockets {
        let _ = sock.send_to(&query_qu, target).await;
        let _ = sock.send_to(&query_qm, target).await;
    }

    let deadline = tokio::time::Instant::now() + window;
    let resend_at = tokio::time::Instant::now() + Duration::from_millis(450);
    let mut resent = false;
    let mut accum = MdnsAccum::default();

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        if !resent && now >= resend_at {
            resent = true;
            for sock in &send_sockets {
                let _ = sock.send_to(&query_qu, target).await;
                let _ = sock.send_to(&query_qm, target).await;
            }
        }
        let next_tick = if !resent {
            resend_at.min(deadline) - now
        } else {
            deadline - now
        };
        if let Ok(Some(pkt)) = tokio::time::timeout(next_tick, rx.recv()).await {
            ingest_mdns_packet(&pkt, &mut accum);
        }
    }

    for task in reader_tasks {
        task.abort();
    }

    assemble_chromecast_devices(&accum)
}

fn extract_ssdp_location(raw: &str) -> Option<String> {
    for line in raw.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("location") {
                let loc = v.trim();
                if loc.starts_with("http://") || loc.starts_with("https://") {
                    return Some(loc.to_string());
                }
            }
        }
    }
    None
}

fn resolve_upnp_url(base: &Url, path: &str) -> Option<String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        return Some(path.to_string());
    }
    base.join(path).ok().map(|u| u.to_string())
}

pub fn parse_upnp_description_xml(location: &str, xml: &str) -> Result<CastDevice> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut stack: Vec<String> = Vec::new();
    let mut url_base: Option<String> = None;
    let mut friendly_name: Option<String> = None;
    let mut manufacturer: Option<String> = None;
    let mut model_name: Option<String> = None;
    let mut udn: Option<String> = None;
    let mut device_type: Option<String> = None;

    let mut cur_service_type = String::new();
    let mut cur_control_url = String::new();
    let mut av_transport_ctrl: Option<String> = None;
    let mut rendering_ctrl: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let tag = e.name().as_ref().to_string();
                if tag == "service" {
                    cur_service_type.clear();
                    cur_control_url.clear();
                }
                stack.push(tag);
            }
            Ok(Event::End(e)) => {
                let qname = e.name();
                if qname.as_ref() == "service" {
                    let st = cur_service_type.to_ascii_lowercase();
                    if st.contains("avtransport") && !cur_control_url.is_empty() {
                        av_transport_ctrl = Some(cur_control_url.clone());
                    } else if st.contains("renderingcontrol") && !cur_control_url.is_empty() {
                        rendering_ctrl = Some(cur_control_url.clone());
                    }
                }
                stack.pop();
            }
            Ok(Event::Text(t)) => {
                let raw = t.into_inner();
                let val = quick_xml::escape::unescape(&raw)
                    .map(|s| s.into_owned())
                    .unwrap_or_else(|_| raw.into_owned());
                if val.is_empty() {
                    continue;
                }
                let parent = stack.last().map(String::as_str).unwrap_or("");
                let in_service = stack.iter().any(|s| s == "service");
                let in_icon = stack.iter().any(|s| s == "icon");
                if in_service {
                    match parent {
                        "serviceType" => cur_service_type = val,
                        "controlURL" => cur_control_url = val,
                        _ => {}
                    }
                } else if !in_icon {
                    match parent {
                        "URLBase" if url_base.is_none() => url_base = Some(val),
                        "friendlyName" if friendly_name.is_none() => friendly_name = Some(val),
                        "manufacturer" if manufacturer.is_none() => manufacturer = Some(val),
                        "modelName" if model_name.is_none() => model_name = Some(val),
                        "UDN" if udn.is_none() => udn = Some(val),
                        "deviceType" if device_type.is_none() => device_type = Some(val),
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(anyhow!("Invalid UPnP device XML: {err}")),
            _ => {}
        }
    }

    let av_rel = av_transport_ctrl.ok_or_else(|| anyhow!("No AVTransport service on renderer"))?;
    let base_url = url_base
        .as_deref()
        .and_then(|u| Url::parse(u).ok())
        .or_else(|| Url::parse(location).ok())
        .ok_or_else(|| anyhow!("Invalid DLNA location URL"))?;

    let host = base_url
        .host_str()
        .ok_or_else(|| anyhow!("Missing DLNA host"))?
        .to_string();
    let port = base_url.port_or_known_default().unwrap_or(80);
    let av_transport_url = resolve_upnp_url(&base_url, &av_rel);
    let rendering_control_url = rendering_ctrl
        .as_deref()
        .and_then(|c| resolve_upnp_url(&base_url, c));

    let id = udn.unwrap_or_else(|| format!("{host}:{port}"));
    let name = friendly_name.unwrap_or_else(|| model_name.clone().unwrap_or_else(|| host.clone()));

    Ok(CastDevice {
        id: format!("dlna:{id}"),
        name,
        model: model_name,
        manufacturer,
        protocol: CastProtocol::Dlna,
        host,
        port,
        av_transport_url,
        rendering_control_url,
    })
}

async fn discover_dlna(
    http: &reqwest::Client,
    adapters: &[crate::cast::probe::LanAdapter],
    window: Duration,
) -> Vec<CastDevice> {
    let mut sockets = Vec::new();
    for adapter in adapters.iter().take(4) {
        if let Ok(sock) = bind_multicast_udp(adapter.ip) {
            sockets.push(std::sync::Arc::new(sock));
        }
    }
    if sockets.is_empty() {
        return Vec::new();
    }

    let target = SocketAddr::V4(SocketAddrV4::new(SSDP_ADDR, SSDP_PORT));
    let search_targets = [
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "urn:schemas-upnp-org:service:AVTransport:1",
        "upnp:rootdevice",
    ];
    let payloads: Vec<String> = search_targets
        .iter()
        .map(|st| {
            format!(
                "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n"
            )
        })
        .collect();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
    let mut reader_tasks = Vec::with_capacity(sockets.len());
    for sock in &sockets {
        let sock_c = std::sync::Arc::clone(sock);
        let tx_c = tx.clone();
        reader_tasks.push(tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok((len, _)) = sock_c.recv_from(&mut buf).await {
                let text = String::from_utf8_lossy(&buf[..len]).into_owned();
                if let Some(loc) = extract_ssdp_location(&text) {
                    if tx_c.send(loc).await.is_err() {
                        break;
                    }
                }
            }
        }));
    }
    drop(tx);

    for msg in &payloads {
        for sock in &sockets {
            let _ = sock.send_to(msg.as_bytes(), target).await;
        }
    }

    let mut locations = HashSet::new();
    let collect_window = ((window * 3) / 4).max(Duration::from_millis(2200));
    let deadline = tokio::time::Instant::now() + collect_window;
    let resend_at = tokio::time::Instant::now() + Duration::from_millis(400);
    let mut resent = false;

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        if !resent && now >= resend_at {
            resent = true;
            for msg in &payloads {
                for sock in &sockets {
                    let _ = sock.send_to(msg.as_bytes(), target).await;
                }
            }
        }
        let next_tick = if !resent {
            resend_at.min(deadline) - now
        } else {
            deadline - now
        };
        if let Ok(Some(loc)) = tokio::time::timeout(next_tick, rx.recv()).await {
            locations.insert(loc);
        }
    }

    for task in reader_tasks {
        task.abort();
    }

    let mut fetches = Vec::new();
    for loc in locations.into_iter().take(24) {
        let client = http.clone();
        fetches.push(async move {
            let resp = client
                .get(&loc)
                .timeout(Duration::from_millis(1800))
                .send()
                .await
                .ok()?;
            let xml = resp.text().await.ok()?;
            parse_upnp_description_xml(&loc, &xml).ok()
        });
    }

    futures_util::future::join_all(fetches)
        .await
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_dns_name(name: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for label in name.trim_end_matches('.').split('.') {
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
        out.push(0);
        out
    }

    #[test]
    fn parses_synthetic_chromecast_mdns_response() {
        let mut pkt = vec![0u8; 12];
        // ANCOUNT = 4 (PTR + SRV + TXT + A)
        pkt[6] = 0;
        pkt[7] = 4;

        let service = "_googlecast._tcp.local";
        let instance = "Living-Room-TV._googlecast._tcp.local";
        let target = "chromecast-abc.local";

        // 1. PTR
        pkt.extend_from_slice(&encode_dns_name(service));
        pkt.extend_from_slice(&12u16.to_be_bytes());
        pkt.extend_from_slice(&1u16.to_be_bytes());
        pkt.extend_from_slice(&120u32.to_be_bytes());
        let ptr_target = encode_dns_name(instance);
        pkt.extend_from_slice(&(ptr_target.len() as u16).to_be_bytes());
        pkt.extend_from_slice(&ptr_target);

        // 2. SRV
        pkt.extend_from_slice(&encode_dns_name(instance));
        pkt.extend_from_slice(&33u16.to_be_bytes());
        pkt.extend_from_slice(&1u16.to_be_bytes());
        pkt.extend_from_slice(&120u32.to_be_bytes());
        let srv_target = encode_dns_name(target);
        pkt.extend_from_slice(&((6 + srv_target.len()) as u16).to_be_bytes());
        pkt.extend_from_slice(&[0, 0, 0, 0]);
        pkt.extend_from_slice(&8009u16.to_be_bytes());
        pkt.extend_from_slice(&srv_target);

        // 3. TXT
        pkt.extend_from_slice(&encode_dns_name(instance));
        pkt.extend_from_slice(&16u16.to_be_bytes());
        pkt.extend_from_slice(&1u16.to_be_bytes());
        pkt.extend_from_slice(&120u32.to_be_bytes());
        let txt_items = ["id=abc123", "fn=Living Room TV", "md=Google TV"];
        let mut txt_raw = Vec::new();
        for item in txt_items {
            txt_raw.push(item.len() as u8);
            txt_raw.extend_from_slice(item.as_bytes());
        }
        pkt.extend_from_slice(&(txt_raw.len() as u16).to_be_bytes());
        pkt.extend_from_slice(&txt_raw);

        // 4. A
        pkt.extend_from_slice(&encode_dns_name(target));
        pkt.extend_from_slice(&1u16.to_be_bytes());
        pkt.extend_from_slice(&1u16.to_be_bytes());
        pkt.extend_from_slice(&120u32.to_be_bytes());
        pkt.extend_from_slice(&4u16.to_be_bytes());
        pkt.extend_from_slice(&[192, 168, 1, 88]);

        let mut accum = MdnsAccum::default();
        ingest_mdns_packet(&pkt, &mut accum);
        let devices = assemble_chromecast_devices(&accum);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Living Room TV");
        assert_eq!(devices[0].model.as_deref(), Some("Google TV"));
        assert_eq!(devices[0].host, "192.168.1.88");
        assert_eq!(devices[0].port, 8009);
        assert_eq!(devices[0].protocol, CastProtocol::Chromecast);
    }

    #[test]
    fn parses_dlna_media_renderer_description_xml() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Samsung QLED TV</friendlyName>
    <manufacturer>Samsung Electronics</manufacturer>
    <modelName>QN55</modelName>
    <UDN>uuid:550e8400-e29b-41d4-a716-446655440000</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/upnp/control/RenderingControl1</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/upnp/control/AVTransport1</controlURL>
      </service>
    </serviceList>
  </device>
</root>"#;

        let dev = parse_upnp_description_xml("http://192.168.1.45:9197/dmr.xml", xml)
            .expect("parse dlna device");
        assert_eq!(dev.protocol, CastProtocol::Dlna);
        assert_eq!(dev.name, "Samsung QLED TV");
        assert_eq!(dev.host, "192.168.1.45");
        assert_eq!(dev.port, 9197);
        assert_eq!(
            dev.av_transport_url.as_deref(),
            Some("http://192.168.1.45:9197/upnp/control/AVTransport1")
        );
        assert_eq!(
            dev.rendering_control_url.as_deref(),
            Some("http://192.168.1.45:9197/upnp/control/RenderingControl1")
        );
    }

    #[test]
    fn builds_both_qu_and_qm_mdns_queries() {
        let qu = build_mdns_ptr_query_with_mode("_googlecast._tcp.local.", true);
        let qm = build_mdns_ptr_query_with_mode("_googlecast._tcp.local.", false);
        assert_eq!(&qu[qu.len() - 4..], &[0x00, 0x0C, 0x80, 0x01]);
        assert_eq!(&qm[qm.len() - 4..], &[0x00, 0x0C, 0x00, 0x01]);
    }
}
