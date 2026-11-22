# PRD: BitChord Desktop (Rust, Windows)

Status: Draft v0.2 | Tanggal: 22 November 2026 | Pemilik: Abel

Dokumen ini mengacu pada analisis repo BitChord (snapshot BitChord-main.zip). Bagian yang belum diverifikasi ditandai "belum diverifikasi".

## 1. Ringkasan

BitChord Desktop adalah pemutar musik desktop untuk Windows, ditulis dengan inti Rust, yang memutar katalog YouTube Music dengan tampilan bergaya Apple Music. Produk ini membawa fitur inti klien Android BitChord (pemutaran gapless, lirik tersinkron, Listen Together, Discord Presence) ke desktop, karena BitChord belum menyediakan aplikasi desktop yang dirilis resmi.

## 2. Latar belakang dan masalah

- Rilis resmi BitChord hanya APK Android (README repo).
- Di Windows, pilihan yang ada hanya web player dan ekstensi browser (`web/` di repo). Keduanya terikat ke browser: tidak ada kontrol media sistem yang rapi, tidak ada kontrol penuh atas output audio, dan pemutaran bergantung pada ekstensi.
- Repo menunjukkan adanya target JVM desktop dan referensi ke "desktop app" (`DesktopYouTubeAuth.kt`), tetapi modul `desktop/` tidak ada di snapshot. Author tidak merilis versi desktop, jadi kode desktop-nya tidak bisa dijadikan referensi.

## 3. Tujuan dan non-tujuan

### Tujuan

1. Memutar lagu dari YouTube Music di Windows dengan latensi mulai kurang dari 3 detik pada koneksi normal.
2. Pemutaran gapless dan antrean yang stabil, dengan kontrol media Windows (tombol media, overlay volume).
3. Lirik tersinkron dan Listen Together yang kompatibel dengan server BitChord yang sudah ada.
4. Satu installer Windows yang ringan, tanpa JVM dan tanpa ekstensi browser.

### Non-tujuan (versi awal)

- macOS dan Linux (struktur kode dijaga agar bisa menyusul, tapi tidak dijanjikan).
- Fitur TV dan Wear OS.
- Hosting konten atau penyimpanan musik di server milik kita.
- Menjamin pemutaran selamanya: resolusi stream YouTube berubah-ubah (lihat bagian Risiko).

## 4. Pengguna dan skenario

| Pengguna | Skenario utama |
| --- | --- |
| Pendengar harian di Windows | Cari lagu, putar, biarkan jalan di latar belakang sambil bekerja, atur lewat tombol media |
| Pengguna Android BitChord | Mau pengalaman yang sama di PC, termasuk akun, favorit, dan Listen Together |
| Kelompok teman | Mendengarkan bersama lewat kode party 6 karakter, campuran perangkat Android dan Windows |

## 5. Asumsi dan keputusan terbuka

- **Jalur arsitektur (diputuskan).** Dipilih **Jalur A**: Tauri 2 dengan inti Rust, UI `web/app` (React 19 + Vite) dipakai ulang, dan layer bridge ekstensi digantikan perintah Rust. Alternatifnya Jalur B (UI Rust murni dengan Slint atau iced), yang jauh lebih lama karena UI harus ditulis ulang (sekitar 190 file di `web/app` dan 139 di `sharedUi`). Jalur B tidak dipilih.
- Inti Rust menggantikan peran ekstensi browser (permintaan jaringan, cookie, header). Ini kesimpulan dari dokumen `web/docs/youtube-signin.md`, belum diverifikasi di kode `web/shared`.
- Aplikasi tidak membawa server Listen Together default; kita menjalankan instans sendiri (satu instans, tanpa database). Alamatnya diisi pengguna, seperti di aplikasi Android.

## 6. Lingkup fitur

### P0 (wajib untuk rilis pertama)

| Fitur | Kriteria penerimaan | Rujukan di repo |
| --- | --- | --- |
| Cari, jelajah, putar | Hasil pencarian tampil dan lagu terputar dari hasil | `data/innertube/`, `YtMusicRepository.kt` |
| Antrean | Tambah, hapus, pindah, putar berikutnya, riwayat | `playback/QueueBuilder.kt`, `QueueTimeline.kt` |
| Gapless playback | Tidak ada jeda terdengar antar lagu pada album gapless | `playback/` |
| Kontrol media Windows | Tombol media dan overlay sistem berfungsi | (baru, SMTC) |
| Tema dari artwork dan UI utama | Halaman Beranda, Cari, Library, Sedang Diputar | `web/app`, `web/docs/apple-music-dom.md` |

### P1 (rilis berikutnya)

| Fitur | Kriteria penerimaan | Rujukan di repo |
| --- | --- | --- |
| Lirik tersinkron | Baris aktif tersorot, minimal provider LRCLIB | `data/lyrics/LrcLib.kt` |
| Sign-in akun Google | Beranda personal, library, suka dan batal suka | `web/docs/youtube-signin.md` |
| Listen Together | Lihat kriteria di bawah tabel | `backend/README.md`, `ServerClock.kt` |
| Discord Rich Presence | Lagu, artis, dan progres tampil di Discord | `com/my/kizzy/` |
| Scrobbling Last.fm dan ListenBrainz | Scrobble terkirim setelah ambang putar | (baru) |
| Download offline | File tersimpan dengan metadata tertanam | (baru) |

### P2 (masuk rilis pertama)

- Crossfade 0 sampai 12 detik, kecepatan putar 0,5x sampai 2,0x, sleep timer, equalizer.
- Automix (beat-matching): `TransitionPlanner.kt`, `BeatTracker.kt`, C++ di `native/analyzer` dan `native/loopmix`. Port Automix bersifat AGPL (lihat bagian Lisensi).
- Bit-perfect untuk sebanyak mungkin DAC: WASAPI exclusive (DSD lewat DoP), ASIO untuk DAC dengan driver vendor (lisensi GPLv3 tersedia sejak Oktober 2025), deteksi kemampuan perangkat, dan konversi format dengan dither bila DAC tidak menerima format lagu. Stream yang dikonversi tidak dilaporkan bit-perfect. Target realistis: semua DAC class-compliant; "semua DAC di pasar" tidak bisa dijamin.
- Lirik word-synced dari banyak provider, terjemahan lirik, library lokal, impor Spotify.

### Kriteria penerimaan Listen Together (dari `backend/README.md`)

- Membuat dan bergabung ke party dengan kode 6 karakter, maksimal 5 perangkat.
- Klien memakai token Bearer yang dikirim di header handshake WebSocket, bukan di URL.
- Posisi putar dihitung dari `positionMs`, `anchorMs`, dan offset jam server (sampel dengan round trip terkecil), bukan dari pesan "putar sekarang".
- Klien mengabaikan state yang `seq`-nya tidak lebih besar dari yang sudah diterapkan.
- Antrean diminta ulang (`syncQueue`) bila `queueSeq` berbeda dari state.
- Perangkat Windows dan Android dalam satu party tetap sejajar waktu putarnya.

## 7. Arsitektur (Jalur A, asumsi)

Cargo workspace dengan modul terpisah:

- `core-playback`: decode (`symphonia`), output (`cpal`, WASAPI), mixer gapless dan crossfade, antrean. Nama crate belum diverifikasi versinya.
- `core-youtube`: pencarian, metadata, dan resolusi stream. Kandidat: `rustypipe` (status belum diverifikasi) atau port logika dari `InnerTubeX`.
- `core-party`: klien Listen Together (`tokio`, `tokio-tungstenite`) dan jam server.
- `core-lyrics`: provider lirik, mulai dari LRCLIB.
- `integrations`: Discord RPC, scrobbler, kontrol media sistem (`souvlaki`).
- `app-tauri`: Tauri 2 dan UI `web/app`; perintah Rust menggantikan bridge ekstensi.

Efek kaca di Windows lewat `window-vibrancy` (Mica atau Acrylic), belum diverifikasi kecocokannya dengan Tauri 2.

## 8. Persyaratan non-fungsional

- Platform: Windows 10 dan 11, 64-bit.
- Performa: waktu ke audio pertama kurang dari 3 detik (sebagai pembanding, web player di repo mengukur sekitar 1 detik per lagu setelah sesi pertama, `web/docs/youtube-playback.md`); pemakaian CPU rendah saat idle.
- Keandalan: bila satu cara resolusi stream gagal (HTTP 401 atau 403 di tengah lagu), pemutaran lanjut dengan cara berikutnya di posisi yang sama, seperti perilaku web player.
- Privasi: cookie dan kredensial hanya disimpan lokal dan tidak pernah dikirim ke UI selain nama dan gambar profil.
- Pembaruan: mekanisme pembaruan otomatis, karena resolusi stream sering perlu tambalan.

## 9. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Resolusi stream YouTube berubah atau diblokir | Lagu tidak bisa diputar | Modul `core-youtube` terisolasi, pembaruan cepat, beberapa jalur resolusi cadangan |
| Stream klien web putus sekitar 60 sampai 70 detik; lagu age-restricted butuh sign-in | Pemutaran sebagian | Prioritaskan jalur direct URL yang sudah terukur 17 dari 20 lagu; tampilkan pesan jelas untuk lagu terbatas umur |
| Pelanggaran ketentuan layanan YouTube | Akun atau proyek bermasalah | Disclaimer seperti di README BitChord, pengguna bertanggung jawab; tidak menghosting konten |
| Kewajiban lisensi turunan (GPL, AGPL) | Konflik saat distribusi | Pilih lisensi sejak awal dan catat atribusi |
| Author merilis versi desktop di kemudian hari | Pekerjaan ganda | Pantau Releases; saat ini author tidak merilis versi desktop |
| Kompleksitas Automix dan audio exclusive | Jadwal molor | Letakkan di P2, kerjakan setelah inti stabil |

## 10. Lisensi dan hukum (bukan nasihat hukum)

- BitChord memakai GPLv3. Port yang menerjemahkan kodenya adalah turunan dan harus GPLv3 saat didistribusikan.
- Engine Automix di web adalah port AutoMix karya David Finnegan yang AGPL-3.0 (`web/docs/automix.md`), sehingga port Automix ikut AGPL.
- Kode bit-perfect Android diadaptasi dari Mornye (LGPL-3.0); `signalsmith-stretch` memakai MIT.
- Keputusan: rilis sebagai GPLv3 dan sertakan atribusi. GPLv3 §13 mengizinkan menggabungkan kode AGPLv3 (Automix); bagian AGPL tetap membawa syarat AGPL-nya.

## 11. Milestone

Estimasi waktu diisi setelah M0.

| Milestone | Isi | Selesai bila |
| --- | --- | --- |
| M0 | Keputusan sudah diambil (Jalur A, GPLv3); siapkan server Listen Together sendiri | Keputusan tertulis |
| M1 | Putar satu lagu dari hasil pencarian | Lagu terdengar dari aplikasi Rust |
| M2 | Antrean, gapless, kontrol media Windows | Album gapless diputar tanpa jeda |
| M3 | UI utama dan tema artwork | Alur cari, putar, antrean lewat UI |
| M4 | Lirik, sign-in, Discord, scrobbling, download | Semua kriteria P1 non-party terpenuhi |
| M5 | Listen Together | Party campuran Windows dan Android sejajar |
| M6 | Crossfade, Automix, bit-perfect (WASAPI exclusive, ASIO, DoP) | Semua kriteria P2 terpenuhi |

## 12. Metrik keberhasilan

- Persentase lagu uji yang berhasil diputar (patokan: 17 dari 20 di web player, `web/docs/youtube-playback.md`).
- Waktu ke audio pertama.
- Selisih posisi putar antar perangkat dalam satu party (target ditentukan setelah pengukuran awal).
- Jumlah crash per sesi dan lama sesi pemutaran tanpa gangguan.

## 13. Pertanyaan terbuka

Sudah dijawab (22 November 2026): Jalur A, GPLv3, author tidak merilis versi desktop, dan semua fitur P2 masuk rilis pertama termasuk bit-perfect. Yang masih terbuka:

1. Di mana instans Listen Together dijalankan (VPS kecil, Oracle Always Free, atau lainnya)?
2. Apakah perlu meminta izin author untuk menawarkan servernya sebagai opsi?
3. Cakupan P2 besar untuk satu rilis: urutan pengerjaan di dalam M6 perlu dipecah.
4. DAC apa saja yang tersedia untuk menguji bit-perfect?
