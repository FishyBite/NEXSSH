#[cfg(windows)]
pub fn read_text() -> Result<String, String> {
    use clipboard_win::{Clipboard, Format, Unicode};

    let _clipboard = Clipboard::new_attempts(10)
        .map_err(|_| "The Windows clipboard is busy. Try pasting again.")?;
    if !Unicode.is_format_avail() {
        return Ok(String::new());
    }
    clipboard_win::get(Unicode)
        .map_err(|_| "Could not read text from the Windows clipboard.".into())
}

#[cfg(windows)]
pub fn write_text(app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    use clipboard_win::{Clipboard, Unicode};
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or("Terminal window is unavailable.")?;
    let owner = window
        .hwnd()
        .map_err(|_| "Terminal window is unavailable.")?;
    let _clipboard = Clipboard::new_attempts_for(owner.0.cast(), 10)
        .map_err(|_| "The Windows clipboard is busy. Try copying again.")?;
    clipboard_win::set(Unicode, text)
        .map_err(|_| "Could not copy text to the Windows clipboard.".into())
}

#[cfg(not(windows))]
pub fn read_text() -> Result<String, String> {
    Err("Native clipboard access requires Windows.".into())
}

#[cfg(not(windows))]
pub fn write_text(_app: &tauri::AppHandle, _text: &str) -> Result<(), String> {
    Err("Native clipboard access requires Windows.".into())
}
