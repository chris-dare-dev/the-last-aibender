fn main() {
    // `generate_context!` validates that frontendDist (../dist) exists at
    // compile time; dev and --smoke-test builds may legitimately precede a
    // vite build, so ensure the directory (content is irrelevant here).
    let _ = std::fs::create_dir_all("../dist");
    tauri_build::build()
}
