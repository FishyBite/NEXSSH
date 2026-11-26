mod clipboard;
mod database;
mod diagnostics;
mod files;
mod file_checksum;
mod log_tail;
mod monitor;
mod security;
mod serial;
mod ssh;
mod ssh_attempt;
mod storage;
mod transfers;
mod tunnels;
mod updates;
mod window_style;

use serde_json::{json, Value};
pub use storage::AppState;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
pub use updates::helper_requested as run_update_helper_if_requested;

pub fn required<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {name}"))
}

pub fn dispatch(
    state: &AppState,
    app: &tauri::AppHandle,
    action: &str,
    payload: Value,
) -> Result<Value, String> {
    match action {
        action if action.starts_with("serial_") => serial::dispatch(app, action, payload),
        "clipboard_read_text" => clipboard::read_text().map(Value::String),
        "clipboard_write_text" => {
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .ok_or("Missing clipboard text")?;
            clipboard::write_text(app, text)?;
            Ok(Value::Null)
        }
        "window_theme" => window_style::set_theme(app, payload),
        "window_ready" => {
            window_style::reveal(app)?;
            Ok(Value::Null)
        }
        "diagnostics_report" => Ok(diagnostics::report(state, app, payload)),
        action if action.starts_with("db_") => database::dispatch(state, action, payload),
        action if action.starts_with("updates_") => updates::dispatch(state, action, payload),
        "state_load" => state.config(),
        "state_save" => {
            state.save_config(payload.get("config").cloned().ok_or("Missing config")?)?;
            Ok(json!({"ok":true}))
        }
        "ssh_connect" => ssh::connect(state, app, payload),
        "ssh_begin_connect" => ssh_attempt::begin(state, required(&payload, "attemptId")?),
        "ssh_cancel_connect" => ssh_attempt::cancel(state, required(&payload, "attemptId")?),
        "ssh_open_here" => ssh::open_here(state, app, payload),
        "ssh_check_path_target" => {
            let source = state.session_binding(required(&payload, "sourceId")?)?;
            let target = state.session_binding(required(&payload, "targetId")?)?;
            if source != target {
                return Err("Choose a terminal connected to the same verified host.".into());
            }
            Ok(Value::Null)
        }
        "file_tail" | "file_tail_close" => log_tail::dispatch(state, action, &payload),
        "ssh_attach" | "ssh_write" | "ssh_resize" | "ssh_disconnect" => {
            ssh::control(state, action, payload)
        }
        "sessions_list" => state.sessions_list(),
        "monitor" => monitor::read(state, payload),
        action
            if action.starts_with("keys_")
                || action.starts_with("known_hosts_")
                || action.starts_with("backup_")
                || action.starts_with("snippets_")
                || action == "credential_delete"
                || action == "identity_inspect" =>
        {
            security::dispatch(state, action, payload)
        }
        action if action.starts_with("tunnels_") => tunnels::dispatch(state, action, payload),
        action if action.starts_with("file_checksum_") => file_checksum::dispatch(state, action, &payload),
        action if action.starts_with("file_") => files::dispatch(state, app, action, payload),
        action if action.starts_with("transfer_") => {
            transfers::dispatch(state, app, action, payload)
        }
        _ => Err(format!("Unknown action: {action}")),
    }
}

#[tauri::command]
async fn request(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&state, &app, &action, payload))
        .await
        .map_err(|error| error.to_string())?
}

fn startup_error(app: &tauri::AppHandle, message: String) {
    let exit = app.clone();
    app.dialog().message(message).title("VEXSSH could not open")
        .kind(MessageDialogKind::Error).show(move |_| exit.exit(1));
}

pub fn run() {
    tauri::Builder::default()
        .manage(serial::SerialSessions::default())
        .on_page_load(|webview, event| {
            if webview.label() == "main" && matches!(event.event(), tauri::webview::PageLoadEvent::Started) {
                webview.state::<serial::SerialSessions>().close_all();
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = app.path().app_data_dir().map_err(|error| error.to_string())
                .and_then(|directory| {
                    #[cfg(debug_assertions)]
                    let directory = std::env::var_os("VEXSSH_TEST_DATA_DIR")
                        .or_else(|| std::env::var_os("NEXSSH_TEST_DATA_DIR"))
                        .map(std::path::PathBuf::from)
                        .unwrap_or(directory);
                    AppState::new(directory)
                });
            let state = match state {
                Ok(state) => state,
                Err(error) => {
                    startup_error(app.handle(), format!("Could not open your local workspace data.\n\n{error}"));
                    return Ok(());
                }
            };
            updates::initialize(&state);
            app.manage(state);
            if let Err(error) = window_style::initialize(app.handle()) {
                startup_error(app.handle(), format!("Could not create the workspace window.\n\n{error}"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![request])
        .build(tauri::generate_context!())
        .expect("Unable to initialize VEXSSH")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<serial::SerialSessions>().close_all();
                if let Some(state) = app.try_state::<AppState>() {
                    state.shutdown();
                    updates::on_exit(&state);
                }
            }
        });
}
