//! Last-resort error reporting: show a plain Windows message box, then exit.
//!
//! The release build uses `panic = "abort"` and has no console, so without this
//! a failed start (for example WebView2 cannot be created) closes the app with
//! no trace. Uses `MessageBoxW` from user32 directly, so no extra dependency.

const TITLE: &str = "ARAMPilot";

/// Text shown when the Tauri runtime fails to start (WebView2 is the usual cause).
pub fn startup_error_text(detail: &str) -> String {
    format!(
        "ARAMPilot 無法啟動，通常是 Microsoft Edge WebView2 Runtime 無法使用。\n\
         請安裝或修復 WebView2 Runtime 後再開一次。\n\n詳細資訊：{detail}"
    )
}

/// Text shown when the app panics; with `panic = "abort"` the process ends right after.
///
/// Tauri panics (instead of returning an error) when WebView2 cannot be found or
/// created, so a panic that mentions the webview gets the WebView2 advice.
pub fn panic_text(message: &str) -> String {
    if message.to_ascii_lowercase().contains("webview") {
        startup_error_text(message)
    } else {
        format!("ARAMPilot 發生無法復原的錯誤，需要關閉。\n\n詳細資訊：{message}")
    }
}

/// The human part of a panic: its message, without the source location.
fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| info.to_string())
}

/// Show a blocking error dialog. Also writes the text to stderr for dev runs.
pub fn show_error(text: &str) {
    eprintln!("{text}");
    #[cfg(windows)]
    {
        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }
        #[link(name = "user32")]
        unsafe extern "system" {
            fn MessageBoxW(
                hwnd: *mut core::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                utype: u32,
            ) -> i32;
        }
        // MB_ICONERROR | MB_SETFOREGROUND (MB_OK is 0)
        const FLAGS: u32 = 0x0000_0010 | 0x0001_0000;
        let text = wide(text);
        let caption = wide(TITLE);
        // SAFETY: both buffers are NUL-terminated UTF-16 and outlive the call.
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), FLAGS);
        }
    }
}

/// Route every panic through the error dialog before the default handling runs.
pub fn install_panic_dialog() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        show_error(&panic_text(&panic_message(info)));
        default_hook(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_error_text_names_webview2_and_keeps_the_detail() {
        let text = startup_error_text("CreateWebview(0x8007139F)");
        assert!(text.contains("WebView2"));
        assert!(text.contains("0x8007139F"));
    }

    #[test]
    fn panic_text_gives_webview2_advice_when_tauri_cannot_find_the_runtime() {
        // The message Tauri 2.12 panics with when WebView2 is missing.
        let text = panic_text(
            "Failed to setup app: runtime error: Could not find the webview runtime, make sure it is installed",
        );
        assert!(text.contains("WebView2 Runtime"));
        assert!(text.contains("Could not find the webview runtime"));
    }

    #[test]
    fn panic_text_keeps_the_detail() {
        assert!(panic_text("boom at lib.rs:1").contains("boom at lib.rs:1"));
    }
}
