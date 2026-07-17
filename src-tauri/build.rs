fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("native/macos/mpv_bridge.m")
            .flag("-fobjc-arc")
            .flag("-Wno-deprecated-declarations")
            .define("GL_SILENCE_DEPRECATION", None)
            .compile("ova_mpv_bridge");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=OpenGL");
    }
    tauri_build::build()
}
