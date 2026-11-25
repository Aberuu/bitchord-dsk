---
name: bitchord-release-build
description: Build BitChord Desktop Windows production installers (.exe NSIS and .msi) and publish a GitHub Release.
---

# BitChord Desktop Windows Release Build

Follow these steps to build production Windows installers cleanly:

1. **Stop running instances (prevents `os error 32` file lock on `target\release`):**
   ```powershell
   Get-Process -Name "*bitchord*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
   ```

2. **Build the frontend bundle:**
   ```powershell
   pnpm --dir web --filter @bitchord/app build
   ```

3. **Build Tauri release binary & installers (`nsis` + `msi`):**
   Ensure `C:\mingw64\bin` and `$env:USERPROFILE\.cargo\bin` are in `PATH`, and pass a temporary config overriding `beforeBuildCommand` to `""` (prevents `pnpm --dir ../web` from resolving into `BitChord-main/web`):
   ```powershell
   $cfg = Join-Path $env:TEMP "tauri-nobuild.json"
   '{"build":{"beforeBuildCommand":""}}' | Set-Content -Path $cfg -Encoding UTF8
   $env:PATH = "$env:USERPROFILE\.cargo\bin;C:\mingw64\bin;$env:PATH"
   npx --yes @tauri-apps/cli@2 build --ci -c $cfg
   Remove-Item $cfg -ErrorAction SilentlyContinue
   ```

4. **Verify output installers:**
   - `target\release\bundle\nsis\BitChord_<version>_x64-setup.exe`
   - `target\release\bundle\msi\BitChord_<version>_x64_en-US.msi`

5. **Publish GitHub Release:**
   Write release notes to a UTF-8 Markdown file (never pass double-quoted inline `--notes` in PowerShell, which mangles backticks and backslashes), then create the release:
   ```powershell
   gh release create v<version> "target\release\bundle\nsis\BitChord_<version>_x64-setup.exe" "target\release\bundle\msi\BitChord_<version>_x64_en-US.msi" --title "BitChord Desktop v<version>" --notes-file release-notes.md
   Remove-Item release-notes.md -ErrorAction SilentlyContinue
   ```
