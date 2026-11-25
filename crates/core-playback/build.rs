use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let native_root = manifest_dir
        .join("..")
        .join("..")
        .join("BitChord-main")
        .join("native");

    println!("cargo:rerun-if-changed=cpp/bitchord_automix_ffi.cpp");
    println!(
        "cargo:rerun-if-changed={}",
        native_root.join("analyzer").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        native_root.join("loopmix").display()
    );

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .include(&native_root)
        .include(native_root.join("analyzer"))
        .include(native_root.join("third_party"))
        .file("cpp/bitchord_automix_ffi.cpp")
        .file(native_root.join("analyzer").join("audio_analysis.cpp"))
        .file(native_root.join("analyzer").join("mel_spectrogram.cpp"))
        .file(native_root.join("analyzer").join("resampler.cpp"))
        .file(native_root.join("analyzer").join("tempo_analysis.cpp"))
        .file(native_root.join("analyzer").join("vocal_spectrogram.cpp"))
        .file(native_root.join("loopmix").join("loop_mix_renderer.cpp"))
        .warnings(false);

    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_env == "msvc" {
        build.flag("/O2");
    } else {
        build.flag("-O2");
        if target_env == "gnu" {
            build.cpp_link_stdlib_static(true);
        }
    }

    let gnu_compiler = if target_env == "gnu" {
        Some(build.get_compiler())
    } else {
        None
    };

    build.compile("bitchord_automix_native");

    if let Some(comp) = gnu_compiler {
        for lib_file in ["libstdc++.a", "libwinpthread.a"] {
            if let Ok(out) = comp
                .to_command()
                .arg(format!("-print-file-name={lib_file}"))
                .output()
            {
                if out.status.success() {
                    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let resolved = PathBuf::from(&raw);
                    if resolved.is_file() {
                        if let Some(parent) = resolved.parent() {
                            println!("cargo:rustc-link-search=native={}", parent.display());
                        }
                    }
                }
            }
        }
        println!("cargo:rustc-link-lib=static=winpthread");
    }
}
