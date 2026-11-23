# BitChord Desktop (`bitchord-dsk`)

<div align="center">

**A modern, lightweight YouTube Music desktop player for Windows, engineered with Rust and Tauri 2.**

[![Release](https://img.shields.io/badge/Release-v0.1.0--beta.1-f59e0b?logo=github&logoColor=white)](https://github.com/Aberuu/bitchord-dsk/releases)
[![Status](https://img.shields.io/badge/Status-Beta%20Testing-blueviolet)]()
[![Rust](https://img.shields.io/badge/Rust-2021%20Edition-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-v19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

</div>

---

> [!WARNING]
> ### 🧪 Beta Testing Notice (`v0.1.0-beta.1`)
> **BitChord Desktop is currently in public Beta Testing.**
> While the core playback pipeline, 10-band Web Audio EQ, synced lyrics, listening analytics, and Windows shell integrations are functional, you may encounter occasional edge cases or visual quirks. Feedback, bug reports, and suggestions are welcome!

---

## 🎵 Overview

**BitChord Desktop** is a native Windows client for YouTube Music inspired by Apple Music's sleek aesthetics. Built using a modular **Rust workspace** and **Tauri 2**, it provides a responsive, standalone music experience without relying on browser tabs, heavy Electron wrappers, or JVM runtimes.

---

## 🚦 Release & Feature Status (Beta v0.1.0-beta.1)

| Feature | Status | Notes |
|---|---|---|
| **Audio Playback Engine** | 🟢 Beta Ready | Low-latency Symphonia decoding + CPAL/WASAPI audio output |
| **Web Audio 10-Band EQ** | 🟢 Beta Ready | 10 frequency bands, pre-amp control, and built-in genre presets |
| **Audio Pipeline Inspector**| 🟢 Beta Ready | Real-time monitoring of sample rate, channels, bit depth, and buffer size |
| **Synced Lyrics** | 🟢 Beta Ready | Side panel drawer & full-screen view (LRCLIB, Kugou, YouTube captions) |
| **Windows SMTC Integration**| 🟢 Beta Ready | Hardware media keys, volume overlay, and taskbar thumbnail previews |
| **Windows DPAPI Security** | 🟢 Beta Ready | Hardware-backed `CryptProtectData` encryption for YouTube session tokens |
| **Listening Stats & Replay** | 🟢 Beta Ready | SQLite-backed listening tracker, top songs/artists, and Replay cards |
| **Search & UpNext Queue** | 🟢 Beta Ready | Search options, shortcut quick-select, and dynamic queue timeline |
| **Listen Together (Party)** | 🟡 In Testing | WebSocket party synchronization with server clock drift compensation |
| **Offline Downloads** | ⚪ In Progress | Local audio storage with ID3 metadata embedding (Planned for v0.2.0) |

---

## ✨ Key Capabilities

- **🚀 High-Performance Playback Pipeline**
  - Native audio decoding powered by [`symphonia`](https://github.com/pdeljanov/symphonia) (AAC, MP3, FLAC, Vorbis, Opus, WAV).
  - Low-latency output stream via [`cpal`](https://github.com/RustAudio/cpal) and Windows WASAPI (shared & exclusive modes).
  - Bit-perfect streaming support with auto-dithering fallback.
  - Dynamic audio pipeline dialog with live format inspection.

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
│   ├── core-playback/              # Symphonia decoders, CPAL output, WASAPI stream
│   ├── core-youtube/               # InnerTube API, search, stream resolution
│   ├── core-lyrics/                # LRCLIB, Kugou, and subtitle providers
│   ├── core-stats/                 # Local listening tracker & SQLite replay generator
│   ├── core-party/                 # Listen Together WebSocket client & clock sync
│   ├── core-auth/                  # DPAPI Windows authentication & session store
│   ├── core-integrations/          # SMTC (souvlaki) & Discord Rich Presence
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

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your Windows machine:

1. **Rust & Cargo:** Install from [rustup.rs](https://rustup.rs/) (Stable 64-bit MSVC toolchain).
2. **Node.js & pnpm:** Node.js v22+ and `pnpm` (`npm install -g pnpm`).
3. **C++ Build Tools:** Visual Studio C++ Build Tools or Microsoft Visual C++ Redistributable.

### Setup & Run Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Aberuu/bitchord-dsk.git
   cd bitchord-dsk
   ```

2. **Install frontend dependencies:**
   ```bash
   cd web
   pnpm install
   cd ..
   ```

3. **Run in development mode (with hot reloading):**
   ```bash
   cargo tauri dev
   ```

### Building for Production (Installer)

To compile an optimized Windows `.msi` or `.exe` installer:

```bash
cargo tauri build
```

The output bundle will be located at `src-tauri/target/release/bundle/`.

---

## 📦 Release History

### `v0.1.0-beta.1` (Current - Beta Testing)
- Initial desktop pre-release for Windows.
- Implemented Rust audio pipeline (`core-playback`), WASAPI low-latency output, and 10-band Web Audio EQ.
- Integrated synced lyrics (LRCLIB, Kugou, YouTube captions) with side panel & full-screen view.
- Added Windows SMTC media transport keys and DPAPI credential protection.
- Added SQLite listening tracker (`core-stats`) and interactive Replay cards.
- Integrated search shortcut navigation, context menu system, and queue timeline.

---

## 📜 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
