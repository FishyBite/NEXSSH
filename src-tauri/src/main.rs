#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if nexssh_lib::run_update_helper_if_requested() {
        return;
    }
    nexssh_lib::run();
}
