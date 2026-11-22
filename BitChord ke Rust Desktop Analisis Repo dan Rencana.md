# BitChord ke Rust Desktop: Analisis Repo dan Rencana

Analisis repo https://github.com/kushagrasinghx/BitChord (snapshot BitChord-main.zip, 1905 file) untuk rencana membuat versi desktop Windows dengan Rust. Sumber temuan: `web/docs/`, `ServerClock.kt`, `build.gradle.kts`, `settings.gradle.kts`, `backend/README.md`, `native/third_party/README.md`. File Kotlin besar seperti `Innertube.kt` dan `TransitionPlanner.kt` baru dipetakan, belum dibaca isinya.

## Temuan yang mengubah rencana

### 1. Sudah ada jalur desktop dan web

`shared/` adalah Kotlin Multiplatform dengan target `jvm`, dan ada komentar "the desktop asks for it" di `TransitionPlanner.kt`. `web/docs/youtube-signin.md` menyebut `DesktopYouTubeAuth.kt` dan "the desktop app". Namun modul `desktop/` **tidak ada di zip ini**: `settings.gradle.kts` hanya meng-include `shared`, `sharedUi`, `app`, `tv`, dan `wearos`.

Selain itu ada web player lengkap (React 19 + Vite) dan ekstensi browser yang bisa dipakai di Windows lewat Chrome atau Edge. Cek halaman Releases dan Issues dulu, karena desktop app resmi mungkin sedang dikerjakan. Port Rust tetap valid, hanya konteksnya berubah.

### 2. Bagian paling rapuh: resolusi stream YouTube

Menurut `web/docs/youtube-playback.md`:

- 17 dari 20 lagu uji bisa diputar (Opus itag 251, klien VISIONOS).
- 3 lagu age-restricted butuh sign-in.
- Stream klien web masih putus di sekitar 60 sampai 70 detik.

Di Android ini ditangani `InnerTubeX` dan `NewPipeExtractor`, dua-duanya library JVM yang tidak bisa dipakai langsung dari Rust. Opsinya: crate `rustypipe` (status belum diverifikasi), port manual, atau sidecar JVM. Bagian ini paling sering rusak dan butuh perawatan terus.

### 3. Lisensi (bukan nasihat hukum)

- BitChord memakai GPLv3.
- Engine Automix di web adalah port dari AutoMix karya David Finnegan yang **AGPL-3.0** (`web/docs/automix.md`), jadi port Automix ikut AGPL.
- Kode bit-perfect Android diadaptasi dari Mornye (LGPL-3.0).
- `signalsmith-stretch` memakai MIT (`native/third_party/README.md`).

Paling aman, rilis Rust port sebagai GPLv3 atau AGPLv3.

## Bagian yang bisa langsung diport

| Komponen | Sumber di repo |
| --- | --- |
| Listen Together | `data/listentogether/ServerClock.kt`, `PartyModels.kt`, `backend/README.md` (protokol lengkap) |
| Lirik (20+ provider) | `data/lyrics/`, mulai dari `LrcLib.kt` dan `TtmlLyrics.kt` |
| Antrean | `playback/QueueBuilder.kt`, `QueueTimeline.kt`, `QueueWindow.kt` |
| Automix | `TransitionPlanner.kt`, `BeatTracker.kt`, plus C++ di `native/analyzer` dan `native/loopmix` (bisa di-link lewat FFI) |
| Discord Presence | `com/my/kizzy/` |
| Sign-in YouTube | `web/docs/youtube-signin.md` |

## Dua jalur arsitektur

### A. Tauri 2 + inti Rust, UI `web/app` dipakai ulang

Jalur tercepat karena UI bergaya Apple Music sudah jadi. Layer bridge ekstensi (`web/shared`) bisa digantikan perintah Rust, karena `reqwest` tidak kena CORS. Audio dan Automix tetap bisa ditulis di Rust (`symphonia` + `cpal`). Ini kesimpulan dari dokumen, belum diverifikasi di kode bridge-nya.

### B. UI Rust murni (Slint atau iced)

UI harus ditulis ulang dari nol: sekitar 190 file di `web/app` dan 139 di `sharedUi`. Hasilnya lebih "Rust", tapi jauh lebih lama.

## Langkah berikutnya

Pilih jalur A atau B, lalu scaffold Cargo workspace, dimulai dari klien Listen Together dan jam sinkronisasi karena spesifikasinya paling jelas.
