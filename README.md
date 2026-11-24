# BitChord Desktop (`bitchord-dsk`)

<div align="center">

**A modern, lightweight YouTube Music desktop player for Windows, engineered with Rust and Tauri 2.**

[![Release](https://img.shields.io/badge/Release-v0.8.0--beta.808-f59e0b?logo=github&logoColor=white)](https://github.com/Aberuu/bitchord-dsk/releases)
[![Status](https://img.shields.io/badge/Status-Beta%20Testing-blueviolet)]()
[![Rust](https://img.shields.io/badge/Rust-2021%20Edition-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-v19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

</div>

---

> [!WARNING]
> ### 🧪 Beta Testing Notice (`v0.8.0-beta.808`)
> **BitChord Desktop is currently in public Beta Testing.**
> While the core playback pipeline, 10-band Web Audio EQ, audio device hotplugging, synced lyrics, listening analytics, and Windows shell integrations are functional, you may encounter occasional edge cases or visual quirks. Feedback, bug reports, and suggestions are welcome!

---

## 🎵 Overview

**BitChord Desktop** is a native Windows client for YouTube Music inspired by Apple Music's sleek aesthetics. Built using a modular **Rust workspace** and **Tauri 2**, it provides a responsive, standalone music experience without relying on browser tabs, heavy Electron wrappers, or JVM runtimes.

---

## 🚦 Release & Feature Status (Beta v0.8.0-beta.808)

| Feature | Status | Notes |
|---|---|---|
| **Audio Playback Engine** | 🟢 Beta Ready | Low-latency Symphonia decoding + CPAL/WASAPI audio output |
| **Audio Device Hotplugging**| 🟢 Beta Ready | Dynamic runtime device detection, hot-swap, and device selection modal |
| **Web Audio 10-Band EQ** | 🟢 Beta Ready | 10 frequency bands, pre-amp control, and built-in genre presets |
| **Audio Pipeline Inspector**| 🟢 Beta Ready | Real-time monitoring of sample rate, channels, bit depth, and buffer size |
| **Synced Lyrics** | 🟢 Beta Ready | Side panel drawer & full-screen view (LRCLIB, Kugou, YouTube captions) |
| **Windows SMTC Integration**| 🟢 Beta Ready | Hardware media keys, volume overlay, and taskbar thumbnail previews |
| **Windows DPAPI Security** | 🟢 Beta Ready | Hardware-backed `CryptProtectData` encryption for YouTube session tokens |
| **Listening Stats & Replay** | 🟢 Beta Ready | SQLite-backed listening tracker, top songs/artists, and Replay cards |
| **Search & UpNext Queue** | 🟢 Beta Ready | Search options, shortcut quick-select, and dynamic queue timeline |
| **Listen Together (Party)** | 🟡 In Testing | WebSocket party synchronization with server clock drift compensation |
| **Cast (CastV2 & DLNA)** | 🟢 Beta Ready | Device discovery, media relay, and CastModal playback controls |
| **External Sources** | 🟢 Beta Ready | `core-sources` integration for WebDAV, SMB, JioSaavn, and addons |
| **System Tray Preferences**| 🟢 Beta Ready | Configurable close-to-tray behavior and tray controls |
| **Offline Downloads** | ⚪ In Progress | Local audio storage with ID3 metadata embedding (Planned for v0.2.0) |

---

## ✨ Key Capabilities

- **🚀 High-Performance Playback Pipeline**
  - Native audio decoding powered by [`symphonia`](https://github.com/pdeljanov/symphonia) (AAC, MP3, FLAC, Vorbis, Opus, WAV).
  - Low-latency output stream via [`cpal`](https://github.com/RustAudio/cpal) and Windows WASAPI (shared & exclusive modes).
  - Dynamic audio device hotplugging with audio tap worklet.
  - Bit-perfect streaming support with auto-dithering fallback.
  - Live audio pipeline inspection dialog.

- **🎛️ 10-Band Graphic & Parametric EQ**
  - Interactive Web Audio equalizer with customizable band gains (-12 dB to +12 dB).
  - Real-time pre-amp gain adjustment, mono downmix, and playback speed control (0.5x to 2.0x).
  - Built-in genre presets (Bass Boost, Vocal, Acoustic, Electronic, Rock, Classical, Flat, etc.).

- **🎤 Synced Lyrics**
  - Smooth line-by-line synced lyrics display with active line highlighting and progress scrubbing.
  - Multiple lyrics providers (LRCLIB, Kugou, YouTube Music captions).
  - Side-panel drawer and dedicated full-screen lyrics viewing modes.

- **📊 Listening Stats & Replay**
  - Embedded `core-stats` analytics engine backed by local SQLite.
  - Interactive Replay recap: total listening time, top tracks, top artists, and shareable poster summaries.

- **🪟 Deep Windows Integration**
  - **SMTC (System Media Transport Controls):** Native Windows media keys (Play/Pause, Next, Prev), hardware volume integration, and taskbar thumbnail previews.
  - **DPAPI Credential Encryption:** Secure Windows Data Protection API storage for sensitive session tokens.
  - **Windows Acrylic & Mica** background vibrancy styling.

- **🤝 Social & Integrations**
  - **Listen Together (Party Mode):** Synchronized real-time playback with friends over WebSocket with precise clock drift compensation.
  - **Discord Rich Presence:** Displays track title, artist, album art, and progress on your Discord profile.

---

## 🏗️ Architecture

```
bitchord-dsk/
├── crates/                         # Core Rust crates (Business logic & engine)
│   ├── core-playback/              # Symphonia decoders, CPAL output, WASAPI stream, hotplug, audio tap
│   ├── core-youtube/               # InnerTube API, search, stream resolution
│   ├── core-lyrics/                # LRCLIB, Kugou, and subtitle providers
│   ├── core-stats/                 # Local listening tracker & SQLite replay generator
│   ├── core-party/                 # Listen Together WebSocket client & clock sync
│   ├── core-auth/                  # DPAPI Windows authentication & session store
│   ├── core-integrations/          # SMTC (souvlaki), CastV2/DLNA, & Discord Rich Presence
│   ├── core-sources/               # External sources (WebDAV, SMB, JioSaavn, addons)
│   └── core-downloads/             # Local offline caching & metadata tagging
│
├── src-tauri/                      # Tauri v2 native bridge & Windows commands
│   ├── src/
│   │   ├── auth_windows.rs         # Windows DPAPI implementation
│   │   ├── commands.rs             # Tauri IPC command invocations
│   │   └── lib.rs                  # App setup & plugin initializations
│   └── tauri.conf.json
│
└── web/                            # Frontend Web Application (React 19 + Vite)
    ├── app/                        # Main player SPA (Shell, pages, state, styles)
    └── shared/                     # Shared bridge types & protocol definitions
```

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Core & Engine** | Rust 2021, Tokio (async runtime), Symphonia, CPAL, WASAPI, Rusqlite, Souvlaki |
| **Desktop Shell** | Tauri v2, Windows API (`windows-rs`) |
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS, Lucide Icons |
| **State Management**| Zustand / lightweight reactive stores |

---

## 💻 Setup & Installation Guide

Ikuti langkah-langkah di bawah ini untuk menyiapkan lingkungan pengembangan (development) dan menjalankan **BitChord Desktop** di Windows.

### 1. Prerequisites (Prasyarat Sistem)

Pastikan dependensi berikut sudah terpasang di komputer Windows Anda (Windows 10 atau 11, 64-bit):

1. **Rust & Cargo (MSVC toolchain):**
   - Unduh dan pasang dari [rustup.rs](https://rustup.rs/).
   - Pastikan default target adalah `x86_64-pc-windows-msvc`:
     ```powershell
     rustup default stable-x86_64-pc-windows-msvc
     ```

2. **C++ Build Tools:**
   - Unduh **Visual Studio Build Tools** (atau Visual Studio Community) dari [visualstudio.microsoft.com](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
   - Centang opsi **"Desktop development with C++"** (diperlukan untuk kompilasi modul native Windows dan link library).

3. **Node.js & pnpm:**
   - Pasang Node.js LTS (versi 22+ disarankan) dari [nodejs.org](https://nodejs.org/).
   - Pasang package manager `pnpm` secara global:
     ```powershell
     npm install -g pnpm
     ```

4. **Tauri CLI:**
   - Pasang Tauri CLI versi 2:
     ```powershell
     cargo install tauri-cli --version "^2.0.0" --locked
     ```

5. **Microsoft Edge WebView2 Runtime:**
   - Standar sudah terpasang di Windows 10/11. Jika belum, unduh Evergreen Bootstrapper dari situs resmi Microsoft.

---

### 2. Step-by-Step Setup

#### Langkah 1: Kloning Repositori
```powershell
git clone https://github.com/Aberuu/bitchord-dsk.git
cd bitchord-dsk
```

#### Langkah 2: Pasang Dependensi Frontend (pnpm)
Masuk ke folder `web` dan jalankan instalasi paket:
```powershell
cd web
pnpm install
cd ..
```

#### Langkah 3: Verifikasi Kompilasi Rust Workspace
Periksa apakah seluruh crate Rust dan Tauri bridge terkompilasi tanpa error:
```powershell
cargo check --workspace
```

---

### 3. Menjalankan Aplikasi

#### Mode Desktop Development (Hot-Reloading)
Jalankan aplikasi desktop dengan hot-reloading otomatis untuk frontend (Vite) dan backend (Rust):
```powershell
cargo tauri dev
```
*(Atau gunakan pintasan `pnpm --dir web tauri dev`)*

Aplikasi akan otomatis mengompilasi core Rust, membuka server dev Vite di `http://localhost:5173`, lalu meluncurkan jendela native BitChord Windows.

#### Mode UI Development Saja (Web Browser)
Jika Anda hanya ingin mengerjakan tampilan antarmuka (UI/styling) tanpa menjalankan backend Tauri:
```powershell
cd web
pnpm dev
```
Buka browser di `http://localhost:5173`.

---

### 4. Menjalankan Test / Pengujian

- **Menjalankan Unit Test Frontend:**
  ```powershell
  cd web
  pnpm test
  ```

- **Menjalankan Typecheck TypeScript:**
  ```powershell
  cd web
  pnpm typecheck
  ```

- **Menjalankan Unit Test Rust Workspace:**
  ```powershell
  cargo test --workspace
  ```

---

### 5. Membangun Installer Produksi Windows

Untuk menghasilkan bundle installer mandiri (`.msi` dan `.exe`):

```powershell
cargo tauri build
```

Setelah proses kompilasi selesai, file installer installer siap pakai dapat ditemukan di:
```
src-tauri/target/release/bundle/msi/
src-tauri/target/release/bundle/nsis/
```

---

### 6. Troubleshooting Umum

- **Error: `link.exe not found`:**
  Pastikan Visual Studio C++ Build Tools terpasang dan opsi *"Desktop development with C++"* telah dicentang.
- **Error saat audio device switching:**
  Pastikan perangkat audio Anda tidak dikunci oleh aplikasi lain dalam mode eksklusif (exclusive mode).
- **Error PowerShell script execution:**
  Jika muncul error `execution of scripts is disabled`, buka PowerShell as Administrator dan jalankan:
  ```powershell
  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```

---

## 📦 Release History

### `v0.8.0-beta.808` (Current - Beta Testing)
- **Audio & Playback:** Added Bit-Perfect bypass mode (disables Web Audio EQ & software volume for bit-exact DAC output), audio device hotplugging, audio tap worklet, and direct stream resolver.
- **Casting & External Sources:** Added CastV2 & DLNA casting (`CastModal`), `core-sources` (WebDAV, SMB, JioSaavn, FLAC addon via `scripts/run-flac-addon.ps1`), and system tray close-behavior preferences.
- **UI & Shell:** Added Developer Watermark, refined `TitleBar`, `AppShell`, `FullScreenPlayer`, and custom scrollbar styling.

### `v0.1.0-beta.1`
- Initial desktop pre-release for Windows.
- Implemented Rust audio pipeline (`core-playback`), WASAPI low-latency output, audio device hotplugging, and 10-band Web Audio EQ.
- Integrated synced lyrics (LRCLIB, Kugou, YouTube captions) with side panel & full-screen view.
- Added Windows SMTC media transport keys and DPAPI credential protection.
- Added SQLite listening tracker (`core-stats`) and interactive Replay cards.
- Integrated search shortcut navigation, context menu system, and queue timeline.

---

## 📜 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
