use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, LazyLock,
    },
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Scheme {
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
struct Theme {
    scheme: Scheme,
    #[serde(deserialize_with = "parse_rgb")]
    background: u32,
    #[serde(deserialize_with = "parse_rgb")]
    foreground: u32,
}

fn parse_rgb<'de, D: Deserializer<'de>>(input: D) -> Result<u32, D::Error> {
    let value = String::deserialize(input)?;
    let digits = value.strip_prefix('#').filter(|hex| hex.len() == 6)
        .ok_or_else(|| serde::de::Error::custom("Expected a six-digit hex color"))?;
    u32::from_str_radix(digits, 16).map_err(serde::de::Error::custom)
}

static THEMES: LazyLock<BTreeMap<String, Theme>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/appThemes.json"))
        .expect("Valid bundled app themes")
});

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ThemeRequest {
    theme: String,
}

fn parse_theme(payload: Value) -> Result<Theme, String> {
    let request: ThemeRequest = serde_json::from_value(payload).map_err(|_| "Choose a window theme")?;
    THEMES.get(&request.theme).copied().ok_or_else(|| "Unknown window theme".into())
}

#[cfg(any(windows, test))]
fn colors(theme: Theme) -> (u32, u32) {
    (color_ref(theme.background), color_ref(theme.foreground))
}

#[cfg(any(windows, test))]
const fn color_ref(rgb: u32) -> u32 {
    ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
}

#[cfg(windows)]
fn high_contrast() -> bool {
    use windows::Win32::UI::{
        Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
        WindowsAndMessaging::{
            SystemParametersInfoW, SPI_GETHIGHCONTRAST, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        },
    };
    let mut settings = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    let result = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            settings.cbSize,
            Some(std::ptr::from_mut(&mut settings).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS::default(),
        )
    };
    result.is_err() || settings.dwFlags.contains(HCF_HIGHCONTRASTON)
}

#[cfg(windows)]
fn apply_native(hwnd: windows::Win32::Foundation::HWND, theme: Theme) -> bool {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    let high_contrast = high_contrast();
    let dark = i32::from(!high_contrast && theme.scheme == Scheme::Dark);
    let (caption, text) = if high_contrast {
        (DWMWA_COLOR_DEFAULT, DWMWA_COLOR_DEFAULT)
    } else {
        colors(theme)
    };
    // DWM copies these four-byte values during each call; no window styles or hit-testing change.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            std::ptr::from_ref(&dark).cast(),
            std::mem::size_of_val(&dark) as u32,
        );
        let caption_applied = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            std::ptr::from_ref(&caption).cast(),
            std::mem::size_of_val(&caption) as u32,
        )
        .is_ok();
        let text_applied = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR,
            std::ptr::from_ref(&text).cast(),
            std::mem::size_of_val(&text) as u32,
        )
        .is_ok();
        caption_applied && text_applied
    }
}

fn background(theme: Theme) -> tauri::window::Color {
    let [_, r, g, b] = theme.background.to_be_bytes();
    tauri::window::Color(r, g, b, 255)
}

fn apply_on_main_thread(app: &tauri::AppHandle, theme: Theme) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let _ = window.set_background_color(Some(background(theme)));
    #[cfg(windows)]
    {
        window
            .hwnd()
            .map(|hwnd| apply_native(hwnd, theme))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, theme);
        false
    }
}

fn apply(app: &tauri::AppHandle, theme: Theme) -> bool {
    let (sender, receiver) = mpsc::sync_channel(1);
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = sender.send(apply_on_main_thread(&handle, theme));
        })
        .is_err()
    {
        return false;
    }
    receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(false)
}

struct StartupWindow {
    revealed: AtomicBool,
}

pub fn reveal(app: &tauri::AppHandle) -> Result<(), String> {
    present(app, false)
}

fn present(app: &tauri::AppHandle, fallback: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let startup = handle.state::<StartupWindow>();
        if startup.revealed.load(Ordering::Relaxed) {
            return;
        }
        let shown = handle
            .get_webview_window("main")
            .is_some_and(|window| window.show().is_ok());
        if shown {
            startup.revealed.store(true, Ordering::Relaxed);
        } else if fallback {
            crate::startup_error(&handle, "The application window could not be displayed. Close this message and reopen VEXSSH.".into());
        }
    })
    .map_err(|error| error.to_string())
}

pub fn initialize(app: &tauri::AppHandle) -> tauri::Result<()> {
    let config = app.state::<crate::AppState>().config().ok();
    let mode = config.as_ref().and_then(|config| config.pointer("/settings/theme")).and_then(Value::as_str);
    let initial_id = mode.filter(|id| THEMES.contains_key(*id)).unwrap_or("dark");
    let theme = THEMES[initial_id];
    let scheme = if theme.scheme == Scheme::Light { "light" } else { "dark" };
    let system = mode == Some("system");
    // Document-creation scripts run before the HTML element exists in some WebViews.
    let initialize_theme = format!(r#"(() => {{
        const mode = {system} ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : '{scheme}';
        function apply() {{
            document.documentElement.dataset.theme = mode;
            document.documentElement.dataset.appTheme = {system} ? mode : '{initial_id}';
        }}
        if (document.documentElement) return apply();
        const observer = new MutationObserver(() => {{
            if (document.documentElement) {{ apply(); observer.disconnect(); }}
        }});
        observer.observe(document, {{ childList: true }});
    }})()"#);
    let main = &app.config().app.windows[0];
    let window = tauri::WebviewWindowBuilder::from_config(app, main)?
        .background_color(background(theme))
        .initialization_script(initialize_theme)
        .build()?;
    let native_theme = if system && matches!(window.theme(), Ok(tauri::Theme::Light)) {
        THEMES["light"]
    } else { theme };
    apply_on_main_thread(app, native_theme);
    app.manage(StartupWindow {
        revealed: AtomicBool::new(false),
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Keep the window accessible if the frontend bundle fails to load.
        tokio::time::sleep(Duration::from_secs(8)).await;
        let _ = present(&handle, true);
    });
    Ok(())
}

pub fn set_theme(app: &tauri::AppHandle, payload: Value) -> Result<Value, String> {
    let theme = parse_theme(payload)?;
    Ok(json!({"applied": apply(app, theme)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_resolved_themes_without_native_parameters() {
        for (name, theme) in THEMES.iter() {
            assert_eq!(parse_theme(json!({"theme": name})).unwrap(), *theme);
        }
        for payload in [
            json!({"theme":"system"}),
            json!({"theme":"#000000"}),
            json!({"theme":null}),
            json!({"theme":"dark","hwnd":123}),
            json!({"theme":"dark","captionColor":0}),
            json!({}),
        ] {
            assert!(parse_theme(payload).is_err());
        }
    }

    #[test]
    fn caption_and_text_colors_match_css_themes() {
        let css = include_str!("../../src/styles.css");
        for declaration in [
            "--bg: #0b0d12;",
            "--bg: #f5f6f9;",
            "--text: #f1f3f9;",
            "--text: #171e2d;",
        ] {
            assert!(css.contains(declaration));
        }
        assert_eq!(colors(THEMES["dark"]), (0x120d0b, 0xf9f3f1));
        assert_eq!(colors(THEMES["light"]), (0xf9f6f5, 0x2d1e17));
        for theme in THEMES.values() {
            let bg = background(*theme);
            assert_eq!(colors(*theme).0, u32::from_be_bytes([0, bg.2, bg.1, bg.0]));
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Requires Windows 11 DWM; creates only an isolated unshown native test window"]
    fn hidden_window_accepts_native_colors_without_changing_window_style() {
        use windows::{
            core::w,
            Win32::{
                Foundation::HWND,
                UI::WindowsAndMessaging::{
                    CreateWindowExW, DestroyWindow, GetWindowLongW, IsWindowVisible, GWL_STYLE,
                    WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
                },
            },
        };

        struct HiddenWindow(HWND);
        impl Drop for HiddenWindow {
            fn drop(&mut self) {
                let _ = unsafe { DestroyWindow(self.0) };
            }
        }

        let window = HiddenWindow(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("VEXSSH isolated caption test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                300,
                200,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        });
        let original_style = unsafe { GetWindowLongW(window.0, GWL_STYLE) };
        assert!(!unsafe { IsWindowVisible(window.0) }.as_bool());
        for theme in THEMES.values() {
            assert!(apply_native(window.0, *theme));
            assert_eq!(
                unsafe { GetWindowLongW(window.0, GWL_STYLE) },
                original_style
            );
            assert!(!unsafe { IsWindowVisible(window.0) }.as_bool());
        }
        assert!(!apply_native(HWND::default(), THEMES["dark"]));
    }
}
