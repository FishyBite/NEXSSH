fn main() {
    let dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
        .join("dbbridge.exe");
    let source = "../tools/dbbridge";
    println!("cargo:rerun-if-changed={source}");
    let status = std::process::Command::new("go")
        .current_dir(source)
        .env("CGO_ENABLED", "0")
        .args([
            "build",
            "-mod=readonly",
            "-buildvcs=false",
            "-trimpath",
            "-ldflags=-s -w",
            "-o",
        ])
        .arg(dir)
        .arg(".")
        .status()
        .expect("Install Go to build the embedded VEXSSH database drivers");
    assert!(status.success(), "Failed to build the database drivers");
    tauri_build::build()
}
