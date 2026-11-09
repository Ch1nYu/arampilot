// Prevents additional console window on Windows in every build, DO NOT REMOVE!!
#![windows_subsystem = "windows"]

#[tokio::main]
async fn main() {
    tauri_app_lib::run()
}
