fn main() {
    std::fs::create_dir_all("../dist").expect("failed to create dashboard dist directory");
    tauri_build::build()
}
