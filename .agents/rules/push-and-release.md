---
trigger: model_decision
description: Apply when the user asks to push, bump version, or create a release for bitchord-dsk.
---

# Push, SemVer Versioning & Release Workflow

Whenever the user asks to `push` in this repository:

1. **Inspect Changes & Classify SemVer (`MAJOR.MINOR.PATCH`):**
   - Run `git status -sb` and `git diff --stat` to inspect what changed.
   - **Minor (`PATCH`, `x.y.Z`):** Bugfix, refactor, UI polish, docs, or tests.
   - **Medium (`MINOR`, `x.Y.0`):** New feature or significant module enhancement.
   - **Mayor (`MAJOR`, `X.0.0`):** Major architectural overhaul, massive new core crate, or breaking change.

2. **Bump Version Across Manifests:**
   - Update the version in:
     - `Cargo.toml` (`[workspace.package].version`)
     - `src-tauri/tauri.conf.json` (`version`)
     - `web/package.json` (`version`)
     - `web/app/package.json` (`version`)

3. **Always Update `README.md`:**
   - Update the `Release` and `Status` badges, `Release & Feature Status` table, and add an entry under `## 📦 Release History` for `vX.Y.Z`.

4. **Commit, Tag & Push:**
   - Stage changes, commit, create annotated tag `vX.Y.Z`, and push `main` + `vX.Y.Z` to `origin`.

5. **Always Build & Publish GitHub Release:**
   - For **every** versioned push (**Minor**, **Medium**, and **Mayor**), run the production Windows build using the `bitchord-release-build` skill and publish a GitHub Release (`gh release create vX.Y.Z ...`) with the `.exe` and `.msi` installers attached.
