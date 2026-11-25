#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if vexssh_lib::run_update_helper_if_requested() {
        return;
    }
    vexssh_lib::run();
}
