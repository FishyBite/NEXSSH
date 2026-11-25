use crate::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const PUBLIC_KEY: &str = "81JUyqZaqCmq0uo/gCu87n31oMfbWvmQ0DXzbvzot8Q=";
const PRODUCT: &str = "com.nexssh.desktop";
const TARGET: &str = "x86_64-pc-windows-msvc";
const MAX_EXE: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST: u64 = 4096;
const HELPER_NAME: &str = "NEXSSH-update-helper.exe";
const HELPER_FLAG: &str = "--nexssh-apply-update";
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    product: String,
    version: String,
    target: String,
    file: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParentIdentity {
    pid: u32,
    creation_time: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    stage_id: String,
    manifest: Manifest,
    original_sha256: String,
    armed: Option<ParentIdentity>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LastResult {
    state: String,
    version: String,
    code: String,
    at: u64,
    stage_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareRequest {
    path: String,
}

struct Paths {
    root: PathBuf,
    install: PathBuf,
}

struct Package {
    manifest: Manifest,
    raw_manifest: Vec<u8>,
    signature: Vec<u8>,
    executable: Vec<u8>,
}

fn error(message: &str) -> String {
    message.into()
}

fn public_key() -> Result<VerifyingKey, String> {
    let bytes = STANDARD
        .decode(PUBLIC_KEY)
        .map_err(|_| error("Update verification is unavailable"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| error("Update verification is unavailable"))?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| error("Update verification is unavailable"))
}

fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn safe_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(error("Update paths must be absolute local paths"));
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        match path.components().next() {
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
            _ => return Err(error("Choose an update package on a local disk")),
        }
    }
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(error(
            "Update paths cannot contain parent-directory components",
        ));
    }
    for component in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        let metadata =
            fs::symlink_metadata(component).map_err(|_| error("An update path is unavailable"))?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(error(
                    "Update paths cannot contain junctions or symbolic links",
                ));
            }
        }
        if metadata.file_type().is_symlink() {
            return Err(error("Update paths cannot contain symbolic links"));
        }
    }
    Ok(())
}

fn safe_file(path: &Path) -> Result<(), String> {
    safe_path(path)?;
    if !fs::metadata(path)
        .map_err(|_| error("An update file is unavailable"))?
        .is_file()
    {
        return Err(error("An update file is not a regular file"));
    }
    Ok(())
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    safe_file(path)?;
    let file = File::open(path).map_err(|_| error("Unable to read the update file"))?;
    if file
        .metadata()
        .map_err(|_| error("Unable to inspect the update file"))?
        .len()
        > limit
    {
        return Err(error("The update file exceeds its size limit"));
    }
    read_bounded(file, limit)
}

fn read_bounded(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Unable to read the complete update package"))?;
    if bytes.len() as u64 > limit {
        return Err(error("The update file exceeds its size limit"));
    }
    Ok(bytes)
}

fn hash_file(path: &Path) -> Result<String, String> {
    safe_file(path)?;
    let mut file = File::open(path).map_err(|_| error("Unable to verify the executable"))?;
    if file
        .metadata()
        .map_err(|_| error("Unable to verify the executable"))?
        .len()
        > MAX_EXE
    {
        return Err(error("The executable exceeds the update size limit"));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| error("Unable to verify the executable"))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAX_EXE {
            return Err(error("The executable exceeds the update size limit"));
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_manifest(
    raw: &[u8],
    signature: &[u8],
    current: &str,
    key: &VerifyingKey,
) -> Result<Manifest, String> {
    if raw.len() as u64 > MAX_MANIFEST || signature.len() != 64 {
        return Err(error("The update manifest or signature is invalid"));
    }
    let signature =
        Signature::from_slice(signature).map_err(|_| error("The update signature is invalid"))?;
    key.verify_strict(raw, &signature)
        .map_err(|_| error("This update was not signed by the NEXSSH release key"))?;
    let manifest: Manifest =
        serde_json::from_slice(raw).map_err(|_| error("The signed update manifest is invalid"))?;
    if manifest.schema != 1
        || manifest.product != PRODUCT
        || manifest.target != TARGET
        || manifest.file != "NEXSSH.exe"
        || manifest.size < 256
        || manifest.size > MAX_EXE
        || !is_hash(&manifest.sha256)
        || manifest.version.len() > 64
    {
        return Err(error(
            "This package is not a supported NEXSSH Windows update",
        ));
    }
    let version =
        Version::parse(&manifest.version).map_err(|_| error("The update version is invalid"))?;
    let current = Version::parse(current).map_err(|_| error("The installed version is invalid"))?;
    if version <= current || !version.pre.is_empty() || !version.build.is_empty() {
        return Err(error("Choose a newer stable NEXSSH version"));
    }
    Ok(manifest)
}

fn verify_executable(bytes: &[u8], manifest: &Manifest) -> Result<(), String> {
    if bytes.len() as u64 != manifest.size || hash_bytes(bytes) != manifest.sha256 {
        return Err(error(
            "The update executable does not match its signed checksum",
        ));
    }
    if bytes.len() < 256 || &bytes[..2] != b"MZ" {
        return Err(error("The update is not a Windows executable"));
    }
    let pe = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    if pe < 64
        || pe > 1024 * 1024
        || pe.checked_add(26).is_none_or(|end| end > bytes.len())
        || &bytes[pe..pe + 4] != b"PE\0\0"
        || &bytes[pe + 4..pe + 6] != [0x64, 0x86]
        || &bytes[pe + 24..pe + 26] != [0x0b, 0x02]
    {
        return Err(error(
            "The update is not a supported 64-bit Windows executable",
        ));
    }
    Ok(())
}

fn read_package(path: &Path, current: &str, key: &VerifyingKey) -> Result<Package, String> {
    safe_file(path)?;
    let file = File::open(path).map_err(|_| error("Unable to open the update package"))?;
    if file
        .metadata()
        .map_err(|_| error("Unable to inspect the update package"))?
        .len()
        > MAX_EXE + 64 * 1024
    {
        return Err(error("The update package exceeds its size limit"));
    }
    let mut archive = zip::ZipArchive::with_config(
        zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(0),
        },
        file,
    )
    .map_err(|_| error("Choose a valid NEXSSH update ZIP package"))?;
    if archive.len() != 3
        || archive.has_duplicate_names()
        || archive
            .has_overlapping_files()
            .map_err(|_| error("Invalid update archive"))?
    {
        return Err(error(
            "The update package must contain exactly three release files",
        ));
    }
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| error("Invalid update archive entry"))?;
        let name = entry
            .name()
            .map_err(|_| error("Invalid update archive filename"))?;
        let limit = match name.as_ref() {
            "manifest.json" => MAX_MANIFEST,
            "manifest.sig" => 64,
            "NEXSSH.exe" => MAX_EXE,
            _ => return Err(error("The update package contains an unexpected file")),
        };
        if !names.insert(name.to_string())
            || !entry.is_file()
            || entry.is_symlink()
            || entry.encrypted()
            || entry.compression() != zip::CompressionMethod::Stored
            || entry.size() > limit
        {
            return Err(error(
                "The update archive contains an unsafe or unsupported entry",
            ));
        }
    }
    let raw_manifest = read_bounded(
        archive
            .by_name("manifest.json")
            .map_err(|_| error("Missing update manifest"))?,
        MAX_MANIFEST,
    )?;
    let signature = read_bounded(
        archive
            .by_name("manifest.sig")
            .map_err(|_| error("Missing update signature"))?,
        64,
    )?;
    let manifest = verify_manifest(&raw_manifest, &signature, current, key)?;
    let executable = read_bounded(
        archive
            .by_name("NEXSSH.exe")
            .map_err(|_| error("Missing update executable"))?,
        manifest.size,
    )?;
    verify_executable(&executable, &manifest)?;
    Ok(Package {
        manifest,
        raw_manifest,
        signature,
        executable,
    })
}

fn stage_path(paths: &Paths, id: &str) -> Result<PathBuf, String> {
    let parsed =
        uuid::Uuid::parse_str(id).map_err(|_| error("The pending update identifier is invalid"))?;
    if parsed.to_string() != id {
        return Err(error("The pending update identifier is invalid"));
    }
    Ok(paths.root.join(id))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    safe_path(path.parent().ok_or("Invalid update directory")?)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| error("Unable to create a new update file"))?;
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| error("Unable to save the update file"));
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn write_json(paths: &Paths, name: &str, value: &impl Serialize) -> Result<(), String> {
    safe_path(&paths.root)?;
    let target = paths.root.join(name);
    if target.exists() {
        safe_file(&target)?;
    }
    let temporary = paths
        .root
        .join(format!("metadata-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(value).map_err(|_| error("Unable to encode update metadata"))?;
    write_new(&temporary, &bytes)?;
    let result =
        fs::rename(&temporary, target).map_err(|_| error("Unable to save update metadata"));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_pending(paths: &Paths) -> Result<Option<Pending>, String> {
    let path = paths.root.join("pending.json");
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("Unable to inspect pending update")),
    }
    let pending: Pending = serde_json::from_slice(&read_limited(&path, 16 * 1024)?)
        .map_err(|_| error("Pending update metadata is invalid"))?;
    stage_path(paths, &pending.stage_id)?;
    if !is_hash(&pending.original_sha256) {
        return Err(error("Pending update metadata is invalid"));
    }
    Ok(Some(pending))
}

fn verify_stage(
    paths: &Paths,
    pending: &Pending,
    current: &str,
    key: &VerifyingKey,
    executable: bool,
) -> Result<(), String> {
    let directory = stage_path(paths, &pending.stage_id)?;
    let manifest = verify_manifest(
        &read_limited(&directory.join("manifest.json"), MAX_MANIFEST)?,
        &read_limited(&directory.join("manifest.sig"), 64)?,
        current,
        key,
    )?;
    if manifest != pending.manifest {
        return Err(error("The staged update manifest has changed"));
    }
    if executable {
        verify_executable(
            &read_limited(&directory.join("NEXSSH.exe"), MAX_EXE)?,
            &manifest,
        )?;
    }
    Ok(())
}

fn remove_stage(paths: &Paths, id: &str) -> Result<(), String> {
    let directory = stage_path(paths, id)?;
    if !directory.exists() {
        return Ok(());
    }
    safe_path(&directory)?;
    for name in [
        HELPER_NAME,
        "manifest.json",
        "manifest.sig",
        "NEXSSH.exe",
        "parent-ready.json",
    ] {
        let path = directory.join(name);
        if path.exists() {
            safe_file(&path)?;
            fs::remove_file(path).map_err(|_| error("Unable to remove staged update"))?;
        }
    }
    fs::remove_dir(directory).map_err(|_| error("The update directory contains unexpected files"))
}

fn prepare_at(paths: &Paths, package: Package) -> Result<Pending, String> {
    if !paths.root.exists() {
        safe_path(paths.root.parent().ok_or("Invalid update directory")?)?;
        fs::create_dir(&paths.root).map_err(|_| error("Unable to create update directory"))?;
    }
    safe_path(&paths.root)?;
    let previous = read_pending(paths)?;
    let pending = Pending {
        stage_id: uuid::Uuid::new_v4().to_string(),
        manifest: package.manifest,
        original_sha256: hash_file(&paths.install)?,
        armed: None,
    };
    let directory = stage_path(paths, &pending.stage_id)?;
    fs::create_dir(&directory).map_err(|_| error("Unable to stage the update"))?;
    let result = (|| {
        write_new(&directory.join("manifest.json"), &package.raw_manifest)?;
        write_new(&directory.join("manifest.sig"), &package.signature)?;
        write_new(&directory.join("NEXSSH.exe"), &package.executable)?;
        write_json(paths, "pending.json", &pending)
    })();
    if let Err(error) = result {
        let _ = remove_stage(paths, &pending.stage_id);
        return Err(error);
    }
    if let Some(previous) = previous {
        let _ = remove_stage(paths, &previous.stage_id);
    }
    Ok(pending)
}

fn canonical_install() -> Result<PathBuf, String> {
    let directory = std::env::var_os("LOCALAPPDATA")
        .ok_or("The Windows installation directory is unavailable")?;
    Ok(PathBuf::from(directory)
        .join("Programs")
        .join("NEXSSH")
        .join("NEXSSH.exe"))
}

fn same_path(left: &Path, right: &Path) -> Result<bool, String> {
    safe_file(left)?;
    safe_file(right)?;
    let left =
        fs::canonicalize(left).map_err(|_| error("Unable to resolve the installed application"))?;
    let right = fs::canonicalize(right)
        .map_err(|_| error("Unable to resolve the installed application"))?;
    Ok(left
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy()))
}

fn require_installed(paths: &Paths) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(error(
            "Local updates require the installed NEXSSH release build",
        ));
    }
    let executable =
        std::env::current_exe().map_err(|_| error("Unable to identify this application"))?;
    if !same_path(&executable, &paths.install)? {
        return Err(error(
            "Updates can only be installed from the NEXSSH Start Menu or taskbar application",
        ));
    }
    Ok(())
}

fn paths(state: &AppState) -> Result<Paths, String> {
    Ok(Paths {
        root: state.data_dir().join("updates"),
        install: canonical_install()?,
    })
}

fn status(paths: &Paths) -> Result<Value, String> {
    if require_installed(paths).is_ok() {
        cleanup_completed(paths);
    }
    let current_identity = current_parent().ok();
    let candidate = read_pending(paths).and_then(|pending| pending.map(|pending| {
        verify_stage(paths, &pending, env!("CARGO_PKG_VERSION"), &public_key()?, false)?;
        Ok::<_, String>(json!({"version":pending.manifest.version,"size":pending.manifest.size,"sha256":pending.manifest.sha256,"installOnExit":pending.armed.is_some() && pending.armed == current_identity}))
    }).transpose());
    let (pending, pending_error) = match candidate { Ok(pending) => (pending, None), Err(_) => (None, Some("The pending update is stale or invalid. Cancel it and select the update package again.")) };
    let can_cancel = safe_file(&paths.root.join("pending.json")).is_ok();
    let last_result = read_result(paths).ok().flatten();
    Ok(
        json!({"currentVersion":env!("CARGO_PKG_VERSION"),"source":"local","canInstall":require_installed(paths).is_ok(),"pending":pending,"pendingError":pending_error,"canCancel":can_cancel,"lastResult":last_result}),
    )
}

pub fn dispatch(state: &AppState, action: &str, payload: Value) -> Result<Value, String> {
    let _guard = UPDATE_LOCK
        .lock()
        .map_err(|_| error("Update management is unavailable"))?;
    let paths = paths(state)?;
    if action == "updates_prepare" {
        let request: PrepareRequest = serde_json::from_value(payload)
            .map_err(|_| error("Choose one local update package"))?;
        if request.path.is_empty() || request.path.len() > 32768 || request.path.contains('\0') {
            return Err(error("Invalid update package path"));
        }
        require_installed(&paths)?;
        if read_pending(&paths)?.is_some_and(|pending| {
            pending.armed == current_parent().ok() && pending.armed.is_some()
        }) {
            return Err(error(
                "Cancel the scheduled update before choosing another package",
            ));
        }
        let package = read_package(
            Path::new(&request.path),
            env!("CARGO_PKG_VERSION"),
            &public_key()?,
        )?;
        prepare_at(&paths, package)?;
        return status(&paths);
    }
    if !payload.as_object().is_some_and(|object| object.is_empty()) {
        return Err(error("This update action does not accept extra parameters"));
    }
    match action {
        "updates_status" => status(&paths),
        "updates_install_on_exit" => {
            require_installed(&paths)?;
            let mut pending =
                read_pending(&paths)?.ok_or("Choose and verify an update package first")?;
            verify_stage(
                &paths,
                &pending,
                env!("CARGO_PKG_VERSION"),
                &public_key()?,
                true,
            )?;
            if hash_file(&paths.install)? != pending.original_sha256 {
                return Err(error(
                    "The installed application changed; prepare the package again",
                ));
            }
            pending.armed = Some(current_parent()?);
            write_json(&paths, "pending.json", &pending)?;
            status(&paths)
        }
        "updates_cancel" => {
            let pending = read_pending(&paths).ok().flatten();
            if fs::symlink_metadata(paths.root.join("pending.json")).is_ok() {
                safe_file(&paths.root.join("pending.json"))?;
                fs::remove_file(paths.root.join("pending.json"))
                    .map_err(|_| error("Unable to cancel the pending update"))?;
            }
            if let Some(pending) = pending {
                let _ = remove_stage(&paths, &pending.stage_id);
            }
            status(&paths)
        }
        _ => Err(error("Unknown update action")),
    }
}

fn read_result(paths: &Paths) -> Result<Option<LastResult>, String> {
    let path = paths.root.join("last-result.json");
    if !path.exists() {
        return Ok(None);
    }
    let value: LastResult = serde_json::from_slice(&read_limited(&path, 4096)?)
        .map_err(|_| error("Invalid update result"))?;
    stage_path(paths, &value.stage_id)?;
    if !["installed", "failed"].contains(&value.state.as_str())
        || ![
            "installed",
            "update_start_failed",
            "installation_failed",
            "rollback_failed",
            "restart_failed",
        ]
        .contains(&value.code.as_str())
        || value.version.len() > 64
        || Version::parse(&value.version).is_err()
        || value.at > 9_007_199_254_740_991
    {
        return Err(error("Invalid update result"));
    }
    Ok(Some(value))
}

fn cleanup_completed(paths: &Paths) {
    let Ok(Some(result)) = read_result(paths) else {
        return;
    };
    if result.version != env!("CARGO_PKG_VERSION")
        || !["installed", "restart_failed"].contains(&result.code.as_str())
    {
        return;
    }
    if read_pending(paths)
        .ok()
        .flatten()
        .is_some_and(|pending| pending.stage_id == result.stage_id)
    {
        return;
    }
    let _ = remove_stage(paths, &result.stage_id);
}

pub fn initialize(state: &AppState) {
    let Ok(_guard) = UPDATE_LOCK.lock() else {
        return;
    };
    let Ok(paths) = paths(state) else {
        return;
    };
    if require_installed(&paths).is_ok() {
        cleanup_completed(&paths);
    }
}

fn save_result(paths: &Paths, pending: &Pending, installed: bool, code: &str) {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = write_json(
        paths,
        "last-result.json",
        &LastResult {
            state: if installed { "installed" } else { "failed" }.into(),
            version: pending.manifest.version.clone(),
            code: code.into(),
            at,
            stage_id: pending.stage_id.clone(),
        },
    );
}

#[cfg(windows)]
fn process_creation(handle: windows::Win32::Foundation::HANDLE) -> Result<u64, String> {
    use windows::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }
        .map_err(|_| error("Unable to identify the running application"))?;
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn current_parent() -> Result<ParentIdentity, String> {
    #[cfg(windows)]
    {
        Ok(ParentIdentity {
            pid: std::process::id(),
            creation_time: process_creation(unsafe {
                windows::Win32::System::Threading::GetCurrentProcess()
            })?,
        })
    }
    #[cfg(not(windows))]
    {
        Err(error("Local app updates are supported on Windows"))
    }
}

#[cfg(windows)]
fn wait_for_parent(
    parent: &ParentIdentity,
    install: &Path,
    ready_path: &Path,
) -> Result<(), String> {
    use windows::{
        core::PWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
                PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    let handle = match unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            parent.pid,
        )
    } {
        Ok(handle) => Handle(handle),
        Err(_) => {
            return Err(error(
                "Unable to verify that the original application has exited",
            ))
        }
    };
    if process_creation(handle.0)? != parent.creation_time {
        return Err(error("The original application identity has changed"));
    }
    let mut buffer = vec![0_u16; 32768];
    let mut size = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    }
    .map_err(|_| error("Unable to verify the original application"))?;
    let path = PathBuf::from(
        String::from_utf16(&buffer[..size as usize])
            .map_err(|_| error("Invalid original application path"))?,
    );
    if !same_path(&path, install)? {
        return Err(error("The update parent is not the installed application"));
    }
    write_new(
        ready_path,
        &serde_json::to_vec(parent).map_err(|_| error("Unable to acknowledge update parent"))?,
    )?;
    if unsafe { WaitForSingleObject(handle.0, 30_000) } != WAIT_OBJECT_0 {
        return Err(error(
            "The application did not finish closing; update cancelled",
        ));
    }
    let mut exit_code = u32::MAX;
    unsafe { GetExitCodeProcess(handle.0, &mut exit_code) }
        .map_err(|_| error("Unable to verify application shutdown"))?;
    if exit_code != 0 {
        return Err(error(
            "The application did not exit normally; update cancelled",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(target: &Path, candidate: &Path, backup: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS},
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let target = wide(target);
    let candidate = wide(candidate);
    let backup = wide(backup);
    unsafe {
        ReplaceFileW(
            PCWSTR(target.as_ptr()),
            PCWSTR(candidate.as_ptr()),
            PCWSTR(backup.as_ptr()),
            REPLACE_FILE_FLAGS::default(),
            None,
            None,
        )
    }
    .map_err(|_| error("Unable to replace the installed application"))
}

fn install_with(
    paths: &Paths,
    pending: &Pending,
    replace: impl FnOnce(&Path, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    safe_file(&paths.install)?;
    if hash_file(&paths.install)? != pending.original_sha256 {
        return Err(error("The installed application changed before the update"));
    }
    let parent = paths
        .install
        .parent()
        .ok_or("Invalid installation directory")?;
    safe_path(parent)?;
    let candidate = parent.join(format!("NEXSSH-update-{}.tmp", pending.stage_id));
    if fs::symlink_metadata(&candidate).is_ok() {
        safe_file(&candidate)?;
        fs::remove_file(&candidate)
            .map_err(|_| error("Unable to reset this update's temporary executable"))?;
    }
    let backup = parent.join("NEXSSH.previous.bak");
    if backup.exists() {
        safe_file(&backup)?;
    }
    let executable = read_limited(
        &stage_path(paths, &pending.stage_id)?.join("NEXSSH.exe"),
        MAX_EXE,
    )?;
    verify_executable(&executable, &pending.manifest)?;
    write_new(&candidate, &executable)?;
    struct CandidateCleanup(PathBuf);
    impl Drop for CandidateCleanup {
        fn drop(&mut self) {
            if safe_file(&self.0).is_ok() {
                let _ = fs::remove_file(&self.0);
            }
        }
    }
    let _candidate_cleanup = CandidateCleanup(candidate.clone());
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| error("Unable to prepare the application backup"))?;
    }
    let result = replace(&paths.install, &candidate, &backup);
    let installed = result.is_ok()
        && hash_file(&paths.install).ok().as_deref() == Some(&pending.manifest.sha256);
    if !installed {
        let unchanged = hash_file(&paths.install).ok().as_deref() == Some(&pending.original_sha256);
        if !unchanged {
            if hash_file(&backup).ok().as_deref() != Some(&pending.original_sha256) {
                return Err(error("rollback_failed"));
            }
            if fs::rename(&backup, &paths.install).is_err()
                || hash_file(&paths.install).ok().as_deref() != Some(&pending.original_sha256)
            {
                return Err(error("rollback_failed"));
            }
        }
        if candidate.exists() {
            let _ = fs::remove_file(&candidate);
        }
        return Err(error("replacement_failed"));
    }
    Ok(())
}

pub fn on_exit(state: &AppState) {
    let Ok(_guard) = UPDATE_LOCK.lock() else {
        return;
    };
    let Ok(paths) = paths(state) else {
        return;
    };
    if require_installed(&paths).is_err() {
        return;
    }
    let Ok(Some(pending)) = read_pending(&paths) else {
        return;
    };
    if pending.armed.is_none() || pending.armed != current_parent().ok() {
        return;
    }
    let result = (|| {
        verify_stage(
            &paths,
            &pending,
            env!("CARGO_PKG_VERSION"),
            &public_key()?,
            true,
        )?;
        if hash_file(&paths.install)? != pending.original_sha256 {
            return Err(error("installed_binary_changed"));
        }
        let helper = stage_path(&paths, &pending.stage_id)?.join(HELPER_NAME);
        if !helper.exists() {
            write_new(&helper, &read_limited(&paths.install, MAX_EXE)?)?;
        }
        if hash_file(&helper)? != pending.original_sha256 {
            return Err(error("helper_verification_failed"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let ready = stage_path(&paths, &pending.stage_id)?.join("parent-ready.json");
            if ready.exists() {
                safe_file(&ready)?;
                fs::remove_file(&ready).map_err(|_| error("Unable to reset update handoff"))?;
            }
            std::process::Command::new(helper)
                .arg(HELPER_FLAG)
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|_| error("helper_start_failed"))?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if ready.exists() {
                    if let Ok(bytes) = read_limited(&ready, 1024) {
                        if let Ok(acknowledged) = serde_json::from_slice::<ParentIdentity>(&bytes) {
                            if Some(acknowledged) == pending.armed {
                                break;
                            }
                            return Err(error("Invalid update handoff"));
                        }
                    }
                }
                if std::time::Instant::now() >= deadline {
                    return Err(error("Update helper did not acknowledge shutdown"));
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
        #[cfg(not(windows))]
        return Err(error("unsupported_platform"));
        Ok::<(), String>(())
    })();
    if result.is_err() {
        save_result(&paths, &pending, false, "update_start_failed");
    }
}

pub fn helper_requested() -> bool {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    if !arguments
        .iter()
        .skip(1)
        .any(|argument| argument == HELPER_FLAG)
    {
        return false;
    }
    if arguments.len() == 2 {
        #[cfg(windows)]
        {
            let _ = run_helper();
        }
    }
    true
}

#[cfg(windows)]
fn run_helper() -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|_| error("Unable to identify the update helper"))?;
    safe_file(&executable)?;
    if executable.file_name().and_then(|name| name.to_str()) != Some(HELPER_NAME) {
        return Err(error("Invalid update helper location"));
    }
    let data = PathBuf::from(std::env::var_os("APPDATA").ok_or("Application data is unavailable")?)
        .join(PRODUCT);
    let paths = Paths {
        root: data.join("updates"),
        install: canonical_install()?,
    };
    let pending = read_pending(&paths)?.ok_or("No update is prepared")?;
    let expected_helper = stage_path(&paths, &pending.stage_id)?.join(HELPER_NAME);
    if !same_path(&executable, &expected_helper)?
        || hash_file(&executable)? != pending.original_sha256
    {
        return Err(error("Update helper verification failed"));
    }
    let parent = pending
        .armed
        .as_ref()
        .ok_or("The update was not scheduled")?;
    let result = (|| {
        wait_for_parent(
            parent,
            &paths.install,
            &stage_path(&paths, &pending.stage_id)?.join("parent-ready.json"),
        )?;
        verify_stage(
            &paths,
            &pending,
            env!("CARGO_PKG_VERSION"),
            &public_key()?,
            true,
        )?;
        install_with(&paths, &pending, replace_file)
    })();
    match result {
        Ok(()) => {
            save_result(&paths, &pending, true, "installed");
            let _ = fs::remove_file(paths.root.join("pending.json"));
            if std::process::Command::new(&paths.install)
                .current_dir(paths.install.parent().unwrap())
                .spawn()
                .is_err()
            {
                save_result(&paths, &pending, false, "restart_failed");
            }
            Ok(())
        }
        Err(reason) => {
            save_result(
                &paths,
                &pending,
                false,
                if reason == "rollback_failed" {
                    "rollback_failed"
                } else {
                    "installation_failed"
                },
            );
            Err(error("The update could not be installed"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    struct Fixture {
        directory: PathBuf,
        paths: Paths,
        key: SigningKey,
        executable: Vec<u8>,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("nexssh-update-tests-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            let install_dir = directory.join("installed");
            let data = directory.join("data");
            fs::create_dir(&install_dir).unwrap();
            fs::create_dir(&data).unwrap();
            let paths = Paths {
                root: data.join("updates"),
                install: install_dir.join("NEXSSH.exe"),
            };
            let mut executable = vec![0_u8; 512];
            executable[..2].copy_from_slice(b"MZ");
            executable[0x3c..0x40].copy_from_slice(&128_u32.to_le_bytes());
            executable[128..132].copy_from_slice(b"PE\0\0");
            executable[132..134].copy_from_slice(&[0x64, 0x86]);
            executable[152..154].copy_from_slice(&[0x0b, 0x02]);
            let mut previous = executable.clone();
            previous[300] = 1;
            fs::write(&paths.install, previous).unwrap();
            Self {
                directory,
                paths,
                key: SigningKey::from_bytes(&[17; 32]),
                executable,
            }
        }
        fn manifest(&self) -> Manifest {
            Manifest {
                schema: 1,
                product: PRODUCT.into(),
                version: "99.0.0".into(),
                target: TARGET.into(),
                file: "NEXSSH.exe".into(),
                size: self.executable.len() as u64,
                sha256: hash_bytes(&self.executable),
            }
        }
        fn package(&self) -> Package {
            let manifest = self.manifest();
            let raw_manifest = serde_json::to_vec(&manifest).unwrap();
            let signature = self.key.sign(&raw_manifest).to_bytes().to_vec();
            Package {
                manifest,
                raw_manifest,
                signature,
                executable: self.executable.clone(),
            }
        }
        fn archive(
            &self,
            manifest: &[u8],
            signature: &[u8],
            executable: &[u8],
            extra: Option<&str>,
        ) -> PathBuf {
            let path = self
                .directory
                .join(format!("package-{}.zip", uuid::Uuid::new_v4()));
            let mut archive = ZipWriter::new(File::create(&path).unwrap());
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for (name, data) in [
                ("manifest.json", manifest),
                ("manifest.sig", signature),
                ("NEXSSH.exe", executable),
            ] {
                archive.start_file(name, options).unwrap();
                archive.write_all(data).unwrap();
            }
            if let Some(name) = extra {
                archive.start_file(name, options).unwrap();
                archive.write_all(b"unexpected").unwrap();
            }
            archive.finish().unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
            let resolved = fs::canonicalize(&self.directory).unwrap();
            assert!(
                resolved.starts_with(parent)
                    && self
                        .directory
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("nexssh-update-tests-")
            );
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn signed_package_stages_without_arming_and_revalidates_bytes() {
        let fixture = Fixture::new();
        let package = fixture.package();
        let archive = fixture.archive(
            &package.raw_manifest,
            &package.signature,
            &package.executable,
            None,
        );
        let package = read_package(&archive, "1.0.0", &fixture.key.verifying_key()).unwrap();
        let pending = prepare_at(&fixture.paths, package).unwrap();
        assert!(pending.armed.is_none());
        assert!(read_pending(&fixture.paths)
            .unwrap()
            .unwrap()
            .armed
            .is_none());
        verify_stage(
            &fixture.paths,
            &pending,
            "1.0.0",
            &fixture.key.verifying_key(),
            true,
        )
        .unwrap();
        let file = stage_path(&fixture.paths, &pending.stage_id)
            .unwrap()
            .join("NEXSSH.exe");
        let mut changed = fixture.executable.clone();
        changed[301] = 9;
        fs::write(file, changed).unwrap();
        assert!(verify_stage(
            &fixture.paths,
            &pending,
            "1.0.0",
            &fixture.key.verifying_key(),
            true
        )
        .is_err());
    }

    #[test]
    fn rejects_unsigned_modified_and_unexpected_zip_entries() {
        let fixture = Fixture::new();
        let package = fixture.package();
        let mut signature = package.signature.clone();
        signature[0] ^= 1;
        let bad_signature =
            fixture.archive(&package.raw_manifest, &signature, &package.executable, None);
        assert!(read_package(&bad_signature, "1.0.0", &fixture.key.verifying_key()).is_err());
        let mut binary = package.executable.clone();
        binary[400] ^= 1;
        let bad_binary = fixture.archive(&package.raw_manifest, &package.signature, &binary, None);
        assert!(read_package(&bad_binary, "1.0.0", &fixture.key.verifying_key()).is_err());
        for name in ["../outside.exe", "nested/NEXSSH.exe", "unexpected.txt"] {
            let archive = fixture.archive(
                &package.raw_manifest,
                &package.signature,
                &package.executable,
                Some(name),
            );
            assert!(read_package(&archive, "1.0.0", &fixture.key.verifying_key()).is_err());
        }
        let valid = fixture.archive(
            &package.raw_manifest,
            &package.signature,
            &package.executable,
            None,
        );
        assert!(read_package(&valid, "1.0.0", &public_key().unwrap()).is_err());
    }

    #[test]
    fn rejects_signed_wrong_target_old_versions_extra_fields_and_limits() {
        let fixture = Fixture::new();
        let original = serde_json::to_value(fixture.manifest()).unwrap();
        for (field, replacement) in [
            ("version", json!("1.0.0")),
            ("version", json!("0.9.0")),
            ("version", json!("99.0.0-beta.1")),
            ("target", json!("aarch64-pc-windows-msvc")),
            ("file", json!("../NEXSSH.exe")),
            ("size", json!(MAX_EXE + 1)),
            ("sha256", json!("not-a-checksum")),
            ("password", json!("FAKE-CREDENTIAL-MUST-NOT-BE-ACCEPTED")),
        ] {
            let mut value = original.clone();
            value[field] = replacement;
            let raw = serde_json::to_vec(&value).unwrap();
            let signature = fixture.key.sign(&raw).to_bytes();
            assert!(
                verify_manifest(&raw, &signature, "1.0.0", &fixture.key.verifying_key()).is_err()
            );
        }
        let mut executable = fixture.executable.clone();
        executable[132] = 0;
        let mut manifest = fixture.manifest();
        manifest.sha256 = hash_bytes(&executable);
        assert!(verify_executable(&executable, &manifest).is_err());
        assert!(read_bounded(std::io::repeat(0).take(MAX_MANIFEST + 2), MAX_MANIFEST).is_err());
    }

    #[test]
    fn corrupt_pending_remains_visible_and_cancellable_without_path_escape() {
        let fixture = Fixture::new();
        fs::create_dir(&fixture.paths.root).unwrap();
        fs::write(
            fixture.paths.root.join("pending.json"),
            br#"{"stageId":"../../outside","password":"FAKE-CREDENTIAL"}"#,
        )
        .unwrap();
        let result = status(&fixture.paths).unwrap();
        assert!(result["pending"].is_null());
        assert_eq!(result["canCancel"], true);
        assert!(result["pendingError"].is_string());
        assert!(!result.to_string().contains("FAKE-CREDENTIAL"));
        assert!(stage_path(&fixture.paths, "../../outside").is_err());
        let state = AppState::new(fixture.paths.root.parent().unwrap().to_path_buf()).unwrap();
        dispatch(&state, "updates_cancel", json!({})).unwrap();
        assert!(!fixture.paths.root.join("pending.json").exists());
        assert!(dispatch(
            &state,
            "updates_prepare",
            json!({"path":"x", "target":"outside"})
        )
        .is_err());
        assert!(dispatch(&state, "updates_install_on_exit", json!({})).is_err());
        assert!(require_installed(&fixture.paths).is_err());
    }

    #[test]
    fn replacement_failure_restores_verified_original() {
        let fixture = Fixture::new();
        let original = fs::read(&fixture.paths.install).unwrap();
        let pending = prepare_at(&fixture.paths, fixture.package()).unwrap();
        let result = install_with(&fixture.paths, &pending, |target, _candidate, backup| {
            fs::rename(target, backup).unwrap();
            fs::write(target, b"failed partial replacement").unwrap();
            Err(error("simulated replacement error"))
        });
        assert_eq!(result.unwrap_err(), "replacement_failed");
        assert_eq!(fs::read(&fixture.paths.install).unwrap(), original);
    }

    #[test]
    fn stale_partial_candidate_can_be_retried_without_touching_other_files() {
        let fixture = Fixture::new();
        let pending = prepare_at(&fixture.paths, fixture.package()).unwrap();
        let directory = fixture.paths.install.parent().unwrap();
        let candidate = directory.join(format!("NEXSSH-update-{}.tmp", pending.stage_id));
        let unrelated = directory.join("unrelated.tmp");
        fs::write(&candidate, b"interrupted candidate copy").unwrap();
        fs::write(&unrelated, b"keep").unwrap();
        install_with(&fixture.paths, &pending, |target, candidate, backup| {
            fs::rename(target, backup).unwrap();
            fs::rename(candidate, target).unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            fs::read(&fixture.paths.install).unwrap(),
            fixture.executable
        );
        assert_eq!(fs::read(unrelated).unwrap(), b"keep");
        assert!(!candidate.exists());
    }

    #[test]
    fn rejects_zip_symlink_even_when_manifest_is_signed() {
        let fixture = Fixture::new();
        let package = fixture.package();
        let path = fixture.directory.join("symlink.zip");
        let mut archive = ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        archive.start_file("manifest.json", options).unwrap();
        archive.write_all(&package.raw_manifest).unwrap();
        archive.start_file("manifest.sig", options).unwrap();
        archive.write_all(&package.signature).unwrap();
        archive
            .add_symlink("NEXSSH.exe", "../outside.exe", options)
            .unwrap();
        archive.finish().unwrap();
        assert!(read_package(&path, "1.0.0", &fixture.key.verifying_key()).is_err());
    }

    #[test]
    #[ignore = "Requires NEXSSH_TEST_UPDATE_PACKAGE pointing to a signed release ZIP; verifies only, never installs or launches"]
    fn signed_release_package_interoperates_with_packager() {
        let path = PathBuf::from(
            std::env::var_os("NEXSSH_TEST_UPDATE_PACKAGE").expect("Set NEXSSH_TEST_UPDATE_PACKAGE"),
        );
        let package = read_package(&path, "0.1.5", &public_key().unwrap()).unwrap();
        println!(
            "Verified signed NEXSSH update {} ({} bytes)",
            package.manifest.version, package.manifest.size
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_atomic_replace_preserves_path_and_backup_without_launching() {
        let fixture = Fixture::new();
        let original = fs::read(&fixture.paths.install).unwrap();
        let pending = prepare_at(&fixture.paths, fixture.package()).unwrap();
        verify_stage(
            &fixture.paths,
            &pending,
            "1.0.0",
            &fixture.key.verifying_key(),
            true,
        )
        .unwrap();
        install_with(&fixture.paths, &pending, replace_file).unwrap();
        assert_eq!(
            fs::read(&fixture.paths.install).unwrap(),
            fixture.executable
        );
        assert_eq!(
            fs::read(
                fixture
                    .paths
                    .install
                    .parent()
                    .unwrap()
                    .join("NEXSSH.previous.bak")
            )
            .unwrap(),
            original
        );
    }

    #[test]
    fn completed_stage_cleanup_removes_only_known_files_and_receipt_is_bounded() {
        let fixture = Fixture::new();
        let mut pending = prepare_at(&fixture.paths, fixture.package()).unwrap();
        let stage = stage_path(&fixture.paths, &pending.stage_id).unwrap();
        fs::write(stage.join(HELPER_NAME), b"test helper never executed").unwrap();
        fs::write(stage.join("parent-ready.json"), b"{}").unwrap();
        pending.manifest.version = env!("CARGO_PKG_VERSION").into();
        save_result(&fixture.paths, &pending, true, "installed");
        fs::remove_file(fixture.paths.root.join("pending.json")).unwrap();
        cleanup_completed(&fixture.paths);
        assert!(!stage.exists());
        let mut receipt =
            serde_json::to_value(read_result(&fixture.paths).unwrap().unwrap()).unwrap();
        receipt["message"] = json!("FAKE-CREDENTIAL");
        fs::write(
            fixture.paths.root.join("last-result.json"),
            receipt.to_string(),
        )
        .unwrap();
        assert!(read_result(&fixture.paths).is_err());
        assert!(status(&fixture.paths).unwrap()["lastResult"].is_null());
    }

    #[cfg(windows)]
    #[test]
    fn parent_identity_mismatch_is_rejected_before_wait_or_writes() {
        let fixture = Fixture::new();
        let mut identity = current_parent().unwrap();
        identity.creation_time ^= 1;
        let ready = fixture.directory.join("parent-ready.json");
        assert!(wait_for_parent(&identity, &std::env::current_exe().unwrap(), &ready).is_err());
        assert!(!ready.exists());
    }
}
