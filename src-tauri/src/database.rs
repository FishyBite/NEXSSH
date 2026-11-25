#[path = "database_table.rs"]
mod table;
#[path = "database_credentials.rs"]
mod credentials;
use crate::{required, tunnels, AppState};
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

const DRIVER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/dbbridge.exe"));
const MAX_QUERY: usize = 128 * 1024;
const ROW_LIMIT: usize = 200;
const CELL_LIMIT: usize = 8192;

#[derive(Default)]
pub struct Sessions {
    connections: Mutex<HashMap<String, Arc<Session>>>,
    opening: Mutex<HashMap<String, Arc<Opening>>>,
    driver_dir: Mutex<Option<tempfile::TempDir>>,
}

impl Sessions {
    fn driver_path(&self) -> Result<PathBuf, String> {
        let mut cache = self.driver_dir.lock().map_err(|e| e.to_string())?;
        if let Some(dir) = cache.as_ref() {
            return Ok(dir.path().join("NEXSSH-database.exe"));
        }
        let dir = tempfile::Builder::new()
            .prefix("NEXSSH-drivers-")
            .tempdir()
            .map_err(ioerr)?;
        let path = dir.path().join("NEXSSH-database.exe");
        std::fs::write(
            dir.path().join("THIRD-PARTY-NOTICES.txt"),
            include_bytes!("../../tools/dbbridge/THIRD-PARTY-NOTICES.txt"),
        )
        .map_err(ioerr)?;
        std::fs::write(&path, DRIVER).map_err(ioerr)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .map_err(ioerr)?;
        }
        *cache = Some(dir);
        Ok(path)
    }

    pub fn shutdown(&self) {
        if let Ok(mut opening) = self.opening.lock() {
            for (_, attempt) in opening.drain() {
                attempt.stop();
            }
        }
        if let Ok(mut connections) = self.connections.lock() {
            connections.clear();
        }
    }
}

#[derive(Default)]
struct Opening {
    cancelled: AtomicBool,
    child: Mutex<Option<Arc<Mutex<Child>>>>,
}

impl Opening {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) { Err("Database connection cancelled.".into()) } else { Ok(()) }
    }

    fn stop(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(slot) = self.child.lock() {
            if let Some(child) = slot.as_ref() {
                if let Ok(mut child) = child.lock() { let _ = child.kill(); }
            }
        }
    }
}

struct Task {
    stopped: Arc<AtomicBool>,
    driver: Option<Arc<Mutex<ChildStdin>>>,
}
struct TaskGuard<'a> {
    session: &'a Session,
    id: String,
}
impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.session.jobs.lock() {
            jobs.remove(&self.id);
        }
    }
}
struct Session {
    read_only: bool,
    sqlite_path: Option<PathBuf>,
    jobs: Mutex<HashMap<String, Task>>,
    backend: Mutex<Backend>,
    ssh_session: Option<String>,
    tunnel: Option<String>,
}

enum Backend {
    Sqlite(Connection),
    Driver(Worker),
}

fn ioerr(error: impl std::fmt::Display) -> String {
    error.to_string()
}

struct Worker {
    child: Arc<Mutex<Child>>,
    input: Arc<Mutex<ChildStdin>>,
    output: BufReader<ChildStdout>,
}

impl Worker {
    fn open(path: &Path, profile: &Value, opening: &Opening) -> Result<Self, String> {
        opening.check()?;
        let mut command = Command::new(path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not start database drivers: {e}"))?;
        let input = child.stdin.take().ok_or("Driver input unavailable")?;
        let output = BufReader::new(child.stdout.take().ok_or("Driver output unavailable")?);
        let mut worker = Self {
            child: Arc::new(Mutex::new(child)),
            input: Arc::new(Mutex::new(input)),
            output,
        };
        {
            let mut slot = opening.child.lock().map_err(ioerr)?;
            opening.check()?;
            *slot = Some(worker.child.clone());
        }
        worker.call(&json!({"action":"connect","profile":profile}))?;
        Ok(worker)
    }

    fn call(&mut self, request: &Value) -> Result<Value, String> {
        send(&self.input, request)?;
        self.receive()
    }

    fn receive(&mut self) -> Result<Value, String> {
        let failed = || "Database driver disconnected. Reconnect to continue.".to_string();
        let mut reply = Vec::new();
        (&mut self.output)
            .take(16 * 1024 * 1024)
            .read_until(b'\n', &mut reply)
            .map_err(|_| failed())?;
        if reply.last() != Some(&b'\n') {
            if let Ok(mut child) = self.child.lock() { let _ = child.kill(); }
            return Err(failed());
        }
        let reply: Value = serde_json::from_slice(&reply).map_err(|_| failed())?;
        if let Some(error) = reply["error"].as_str() {
            return Err(error.to_owned());
        }
        Ok(reply["data"].clone())
    }
}

fn send(input: &Mutex<ChildStdin>, request: &Value) -> Result<(), String> {
    let mut stream = input.lock().map_err(ioerr)?;
    serde_json::to_writer(&mut *stream, request).map_err(ioerr)?;
    stream
        .write_all(b"\n")
        .and_then(|_| stream.flush())
        .map_err(ioerr)
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn connect(state: &AppState, mut profile: Value, id: &str, opening: &Opening) -> Result<Value, String> {
    opening.check()?;
    let engine = required(&profile, "engine")?.to_owned();
    let ssh = profile["sshSessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let mut tunnel = None;
    let sessions = &state.inner.databases;
    if let Some(expected) = profile["sshHostId"].as_str().filter(|id| !id.is_empty()) {
        let session_id = ssh.as_deref().ok_or("Connect to the saved SSH host first.")?;
        if state.session_binding(session_id)?.host_id != expected {
            return Err("The selected SSH session belongs to a different jump host.".into());
        }
    }
    let mut read_only = profile["readOnly"].as_bool().unwrap_or(false);
    let mut sqlite_path = None;
    if profile["useSavedPassword"] == true {
        profile["password"] = json!(credentials::read(state, &profile)?);
    }
    let backend = match engine.as_str() {
        "sqlite" => {
            if ssh.is_some() {
                return Err(
                    "Open a local SQLite file or select a network database for SSH.".into(),
                );
            }
            let path = required(&profile, "path")?;
            let conn = if path == ":memory:" {
                Connection::open_in_memory()
            } else if read_only {
                Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            } else {
                // Opening a misspelled path must not create an empty database.
                Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).or_else(|_| {
                    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                })
            }
            .map_err(ioerr)?;
            // SQLite can also silently downgrade OPEN_READ_WRITE when the file is read-only.
            read_only |= conn.is_readonly(rusqlite::DatabaseName::Main).map_err(ioerr)?;
            conn.busy_timeout(Duration::from_secs(5)).map_err(ioerr)?;
            conn.query_row("PRAGMA schema_version", [], |_| Ok(()))
                .map_err(ioerr)?;
            if path != ":memory:" {
                sqlite_path = Some(std::fs::canonicalize(path).map_err(ioerr)?);
            }
            if read_only {
                table::restrict_sqlite(&conn)?;
            }
            Backend::Sqlite(conn)
        }
        "mysql" | "mariadb" | "postgresql" | "sqlserver" | "oracle" | "redis" | "mongodb" => {
            let host = required(&profile, "host")?.trim().to_owned();
            if host.is_empty()
                || host
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace() || "/\\@?#;,".contains(c))
            {
                return Err("Enter a database hostname or IP address.".into());
            }
            let port = profile["port"]
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .filter(|p| *p > 0)
                .ok_or("Enter a valid database port.")?;
            let path = sessions.driver_path()?;
            profile["host"] = json!(host);
            profile["forwardPort"] = json!(0);
            profile["tls"] = json!(profile["tls"].as_bool().unwrap_or(true));
            if let Some(ssh_id) = ssh.as_ref() {
                let (id, local_port) = tunnels::start_database(state, ssh_id, &host, port)?;
                tunnel = Some(id);
                profile["forwardPort"] = json!(local_port);
            }
            match Worker::open(&path, &profile, opening) {
                Ok(driver) => Backend::Driver(driver),
                Err(e) => {
                    if let Some(id) = &tunnel {
                        let _ = tunnels::stop_rule(state, id);
                    }
                    return Err(e);
                }
            }
        }
        _ => return Err("Unsupported database engine".into()),
    };
    // Serialize publication with cancellation. A cancel racing a successful handshake
    // either prevents publication or disconnects the published handle by the same ID.
    let pending = sessions.opening.lock().map_err(ioerr)?;
    let commit = || -> Result<(), String> {
        opening.check()?;
        if let Some(ssh_id) = &ssh { state.session_binding(ssh_id)?; }
        if profile["rememberPassword"] == true {
            credentials::write(state, &profile)?;
        } else if profile["forgetPassword"] == true {
            credentials::forget(state, &profile)?;
        }
        Ok(())
    };
    if let Err(error) = commit() {
        drop(pending);
        drop(backend);
        if let Some(id) = tunnel { let _ = tunnels::stop_rule(state, &id); }
        return Err(error);
    }
    sessions.connections.lock().map_err(ioerr)?.insert(
        id.to_owned(),
        Arc::new(Session {
            backend: Mutex::new(backend),
            read_only,
            sqlite_path,
            jobs: Mutex::new(HashMap::new()),
            ssh_session: ssh,
            tunnel,
        }),
    );
    Ok(json!({"id":id, "readOnly":read_only}))
}

pub fn dispatch(state: &AppState, action: &str, payload: Value) -> Result<Value, String> {
    let sessions = &state.inner.databases;
    if action == "db_password_save" || action == "db_password_forget" {
        if action == "db_password_save" { credentials::write(state, &payload)?; }
        else { credentials::forget(state, &payload)?; }
        return Ok(Value::Null);
    }
    if action == "db_prepare_connect" {
        let id = uuid::Uuid::new_v4().to_string();
        sessions.opening.lock().map_err(ioerr)?.insert(id.clone(), Arc::new(Opening::default()));
        return Ok(json!({"id":id}));
    }
    if action == "db_cancel_connect" {
        let id = required(&payload, "id")?;
        {
            let mut opening = sessions.opening.lock().map_err(ioerr)?;
            if let Some(attempt) = opening.remove(id) { attempt.stop(); }
        }
        return dispatch(state, "db_disconnect", payload);
    }
    if action == "db_connect" {
        if let Some(id) = payload["attemptId"].as_str().map(str::to_owned) {
            let attempt = sessions.opening.lock().map_err(ioerr)?.get(&id).cloned().ok_or("Database connection cancelled.")?;
            let result = connect(state, payload, &id, &attempt);
            sessions.opening.lock().map_err(ioerr)?.remove(&id);
            return result;
        }
        return connect(state, payload, &uuid::Uuid::new_v4().to_string(), &Opening::default());
    }
    let id = required(&payload, "id")?;
    let mut connections = state.inner.databases.connections.lock().map_err(ioerr)?;
    if action == "db_disconnect" {
        let removed = connections.remove(id);
        drop(connections);
        if let Some(tunnel) = removed.as_ref().and_then(|s| s.tunnel.as_deref()) {
            tunnels::stop_rule(state, tunnel)?;
        }
        return Ok(Value::Null);
    }
    let session = connections
        .get(id)
        .cloned()
        .ok_or("Database is disconnected. Reconnect to continue.")?;
    let open_files: Vec<_> = if action == "db_export_csv" {
        connections
            .values()
            .filter_map(|s| s.sqlite_path.clone())
            .collect()
    } else {
        Vec::new()
    };
    drop(connections);
    if action == "db_cancel" {
        let jobs = session.jobs.lock().map_err(ioerr)?;
        let id = required(&payload, "requestId")?;
        if let Some(task) = jobs.get(id) {
            task.stopped.store(true, Ordering::Release);
            if let Some(writer) = &task.driver {
                send(writer, &json!({"action":"cancel","requestId":id}))?;
            }
            return Ok(json!({"cancelled":true}));
        }
        return Ok(json!({"cancelled":false}));
    }
    if let Some(ssh) = &session.ssh_session {
        state.session_binding(ssh)?;
    }
    let request_id = payload["requestId"].as_str().filter(|key| !key.is_empty());
    let stopped = Arc::new(AtomicBool::new(false));
    let _job = if action == "db_query" {
        if let Some(key) = request_id {
            if key.len() > 128 {
                return Err("Invalid query request ID.".into());
            }
            let mut jobs = session.jobs.lock().map_err(ioerr)?;
            if jobs.contains_key(key) {
                return Err("This query is already running.".into());
            }
            jobs.insert(
                key.to_owned(),
                Task {
                    stopped: stopped.clone(),
                    driver: None,
                },
            );
            Some(TaskGuard {
                session: &session,
                id: key.to_owned(),
            })
        } else {
            None
        }
    } else {
        None
    };
    let mut export = None;
    let mut request = payload.clone();
    match action {
        "db_query" => {
            if required(&payload, "query")?.len() > MAX_QUERY {
                return Err("Enter a query smaller than 128 KiB.".into());
            }
            request["action"] = json!("query");
        }
        "db_update_cell" | "db_table_page" | "db_export_csv" | "db_preview" => {
            request["object"] = json!({"name":required(&payload,"name")?,"schema":payload["schema"].as_str().unwrap_or("main"),"kind":payload["kind"].as_str().unwrap_or("table")});
            request["action"] = json!(match action {
                "db_update_cell" => {
                    if session.read_only {
                        return Err("This connection is read-only.".into());
                    }
                    for key in ["oldValue", "newValue"] {
                        if !payload
                            .get(key)
                            .is_some_and(|value| value.is_null() || value.is_string())
                        {
                            return Err(
                                "Supply a string or NULL for both the old and new cell values."
                                    .into(),
                            );
                        }
                    }
                    "update"
                }
                "db_export_csv" => {
                    let dest = PathBuf::from(required(&payload, "path")?);
                    let temp = table::csv_target(&dest, &open_files)?;
                    request["path"] = json!(temp.path());
                    export = Some((temp, dest));
                    "export"
                }
                "db_preview" => "preview",
                _ => "page",
            });
        }
        "db_objects" => request["action"] = json!("objects"),
        _ => return Err("Unknown database operation".into()),
    }
    let mut backend = session.backend.lock().map_err(ioerr)?;
    if stopped.load(Ordering::Acquire) {
        return Err("Query cancelled.".into());
    }
    if let Backend::Sqlite(db) = &*backend {
        let deadline = std::time::Instant::now()
            + Duration::from_secs(if export.is_some() { 300 } else { 30 });
        let stop = stopped.clone();
        db.progress_handler(
            1000,
            Some(move || stop.load(Ordering::Acquire) || std::time::Instant::now() >= deadline),
        );
    }
    let result = match &mut *backend {
        Backend::Driver(worker) if _job.is_some() => {
            let mut jobs = session.jobs.lock().map_err(ioerr)?;
            let task = jobs
                .get_mut(request_id.unwrap())
                .ok_or("Query no longer active")?;
            if task.stopped.load(Ordering::Acquire) {
                return Err("Query cancelled.".into());
            }
            send(&worker.input, &request)?;
            task.driver = Some(worker.input.clone());
            drop(jobs);
            worker.receive()
        }
        Backend::Driver(worker) => worker.call(&request),
        Backend::Sqlite(db)
            if matches!(action, "db_table_page" | "db_update_cell" | "db_export_csv") =>
        {
            table::execute(db, &request)
        }
        Backend::Sqlite(db) if action == "db_objects" => {
            let mut q = db.prepare("SELECT name, type FROM main.sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY name").map_err(ioerr)?;
            let objects = q.query_map([], |row| Ok(json!({"schema":"main","name":row.get::<_,String>(0)?,"kind":row.get::<_,String>(1)?})))
                .map_err(ioerr)?.take(2000).collect::<Result<Vec<_>,_>>().map_err(ioerr)?;
            Ok(Value::Array(objects))
        }
        Backend::Sqlite(db) if action == "db_preview" => {
            let name = required(&payload, "name")?.replace('"', "\"\"");
            sqlite_query(db, &format!("SELECT * FROM main.\"{name}\" LIMIT 201"))
        }
        Backend::Sqlite(db) => sqlite_query(db, required(&payload, "query")?),
    };
    let value = match result {
        Err(error) if stopped.load(Ordering::Acquire) => {
            if matches!(*backend, Backend::Sqlite(_)) {
                return Err("Query cancelled.".into());
            }
            return Err(format!("Cancellation requested. {error}. Check the server outcome before retrying. Reconnect if the session closed."));
        }
        other => other?,
    };
    if let Some((temp, path)) = export {
        temp.persist(path).map_err(ioerr)?;
    }
    Ok(value)
}

fn sqlite_query(db: &Connection, query: &str) -> Result<Value, String> {
    let mut batch = rusqlite::Batch::new(db, query);
    let mut stmt = batch
        .next()
        .map_err(ioerr)?
        .ok_or("Enter a SQL statement.")?;
    if batch.next().map_err(ioerr)?.is_some() {
        return Err("Run one SQL statement at a time.".into());
    }
    let columns: Vec<_> = stmt.column_names().into_iter().map(str::to_owned).collect();
    if columns.is_empty() {
        let before = db.total_changes();
        stmt.execute([]).map_err(ioerr)?;
        return Ok(
            json!({"columns":[],"rows":[],"affected":db.total_changes()-before,"truncated":false}),
        );
    }
    let mut cursor = stmt.query([]).map_err(ioerr)?;
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut total = 0;
    while let Some(row) = cursor.next().map_err(ioerr)? {
        if rows.len() == ROW_LIMIT {
            truncated = true;
            break;
        }
        let mut cells = Vec::new();
        for i in 0..columns.len() {
            let cell = match row.get_ref(i).map_err(ioerr)? {
                ValueRef::Null => None,
                ValueRef::Integer(v) => Some(v.to_string()),
                ValueRef::Real(v) => Some(v.to_string()),
                ValueRef::Blob(v) => Some(format!("[{} bytes]", v.len())),
                ValueRef::Text(v) => {
                    let part = &v[..v.len().min(CELL_LIMIT)];
                    let mut s = String::from_utf8_lossy(part).into_owned();
                    if part.len() < v.len() {
                        s.push('…');
                        truncated = true;
                    }
                    Some(s)
                }
            };
            total += cell.as_ref().map_or(1, String::len);
            cells.push(cell);
        }
        if total > 1024 * 1024 {
            truncated = true;
            break;
        }
        rows.push(cells);
    }
    Ok(json!({"columns":columns,"rows":rows,"truncated":truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_a_pending_database_handshake_closes_socket_and_handle() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let id = dispatch(&state, "db_prepare_connect", json!({})).unwrap()["id"].clone();
        let other = state.clone();
        let profile = json!({"attemptId":id,"engine":"mysql","host":"127.0.0.1",
            "port":port,"username":"qa","tls":false});
        let worker = std::thread::spawn(move || dispatch(&other, "db_connect", profile));
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut sock = loop {
            match listener.accept() {
                Ok((sock, _)) => break sock,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline && !worker.is_finished(), "driver did not reach the local fixture");
                    std::thread::sleep(Duration::from_millis(15));
                }
                Err(error) => panic!("{error}"),
            }
        };
        sock.set_nonblocking(false).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        dispatch(&state, "db_cancel_connect", json!({"id":id})).unwrap();
        match sock.read(&mut [0; 512]) {
            Ok(0) => {}
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
            result => panic!("cancelled socket still connected: {result:?}"),
        }
        assert!(worker.join().unwrap().is_err());
        assert!(state.inner.databases.opening.lock().unwrap().is_empty());
        assert!(state.inner.databases.connections.lock().unwrap().is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn sqlite_file_permissions_determine_live_connection_mode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("records.sqlite");
        Connection::open(&path).unwrap()
            .execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1);")
            .unwrap();
        let original = std::fs::metadata(&path).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&path, readonly).unwrap();

        let state = AppState::new(directory.path().join("app")).unwrap();
        let profile = json!({"engine":"sqlite", "path":path, "readOnly":false});
        let session = dispatch(&state, "db_connect", profile.clone()).unwrap();
        let id = &session["id"];
        let read = dispatch(&state, "db_query", json!({"id":id, "query":"SELECT id FROM records"})).unwrap();
        let write = dispatch(&state, "db_query", json!({"id":id, "query":"CREATE TEMP TABLE draft(id INT)"}));
        dispatch(&state, "db_disconnect", json!({"id":id})).unwrap();
        std::fs::set_permissions(&path, original).unwrap();
        let writable = dispatch(&state, "db_connect", profile).unwrap();
        assert_eq!(session["readOnly"], true);
        assert_eq!(read["rows"][0][0], "1");
        assert!(write.is_err());
        assert_eq!(writable["readOnly"], false);
    }

    #[test]
    fn table_pages_edits_csv_read_only_and_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local.csv"); // even a database named .csv cannot be overwritten by export
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE orders(tenant INT, id INT, body TEXT, PRIMARY KEY(tenant,id));
            INSERT INTO orders VALUES(1,1,'Q_% demo'),(1,2,'Q_% next'),(2,1,'irrelevant');",
            )
            .unwrap();
        let state = AppState::new(dir.path().join("app")).unwrap();
        let open = |ro| {
            dispatch(
                &state,
                "db_connect",
                json!({"engine":"sqlite","path":path,"readOnly":ro}),
            )
            .unwrap()["id"]
                .clone()
        };
        let id = open(false);
        let mut p = json!({"id":id,"schema":"main","name":"orders","kind":"table","offset":0,"limit":1,"filterColumn":"body","filterValue":"_%","sortColumn":"id","sortDirection":"desc"});
        let page = dispatch(&state, "db_table_page", p.clone()).unwrap();
        assert_eq!(page["rows"][0][2], "Q_% next");
        assert_eq!(page["metadata"][0]["primaryKey"], true);
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["editableRows"][0], true);
        p["offset"] = json!(1);
        assert_eq!(
            dispatch(&state, "db_table_page", p.clone()).unwrap()["rows"][0][2],
            "Q_% demo"
        );
        let update = json!({"id":id,"schema":"main","name":"orders","kind":"table","key":{"tenant":"1","id":"1"},"column":"body","oldValue":"Q_% demo","newValue":"Q_% updated"});
        assert!(dispatch(&state, "db_update_cell", update.clone()).is_ok());
        assert!(dispatch(&state, "db_update_cell", update.clone()).is_err());
        p["scope"] = json!("all");
        p["path"] = json!(path);
        assert!(dispatch(&state, "db_export_csv", p.clone()).is_err());
        let dest = dir.path().join("filtered.csv");
        p["path"] = json!(dest);
        assert_eq!(
            dispatch(&state, "db_export_csv", p.clone()).unwrap()["rows"],
            2
        );
        assert!(std::fs::read_to_string(dest)
            .unwrap()
            .contains("Q_% updated"));
        let readonly = open(true);
        let mut update = update;
        update["id"] = readonly.clone();
        assert!(dispatch(&state, "db_update_cell", update).is_err());
        for query in [
            "DELETE FROM orders",
            "PRAGMA query_only=OFF",
            "ATTACH ':memory:' AS other",
            "CREATE TEMP TABLE writes(x)",
        ] {
            assert!(
                dispatch(&state, "db_query", json!({"id":readonly,"query":query})).is_err(),
                "{query}"
            );
        }
        p["id"] = readonly.clone();
        assert!(dispatch(&state, "db_table_page", p).is_ok());
        let cancel_state = state.clone();
        let cancel_id = id.clone();
        let run = std::thread::spawn(move || {
            dispatch(
                &cancel_state,
                "db_query",
                json!({"id":cancel_id,"requestId":"slow","query":"WITH RECURSIVE t(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM t WHERE n<1000000000) SELECT SUM(n) FROM t"}),
            )
        });
        let start = std::time::Instant::now();
        loop {
            let cancelled =
                dispatch(&state, "db_cancel", json!({"id":id,"requestId":"slow"})).unwrap();
            if cancelled["cancelled"] == true {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(3));
        }
        assert!(run.join().unwrap().unwrap_err().contains("cancelled"));
        assert_eq!(
            dispatch(&state, "db_query", json!({"id":id,"query":"SELECT 42"})).unwrap()["rows"][0]
                [0],
            "42"
        );
    }
    #[test]
    fn sqlite_database_workspace_keeps_session_and_bounds_previews() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().to_owned()).unwrap();
        let id = dispatch(
            &state,
            "db_connect",
            json!({"engine":"sqlite","path":":memory:"}),
        )
        .unwrap()["id"]
            .clone();
        let query = |s: &str| dispatch(&state, "db_query", json!({"id":id,"query":s})).unwrap();
        query("CREATE TABLE \"order items\"(n INTEGER, note TEXT)");
        assert_eq!(query("WITH RECURSIVE t(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM t WHERE n<205) INSERT INTO \"order items\" SELECT n,NULL FROM t")["affected"],205);
        let o = dispatch(&state, "db_objects", json!({"id":id})).unwrap();
        assert_eq!(o[0]["name"], "order items");
        let g = dispatch(
            &state,
            "db_preview",
            json!({"id":id,"schema":"main","name":"order items"}),
        )
        .unwrap();
        assert_eq!(g["rows"].as_array().unwrap().len(), 200);
        assert_eq!(g["rows"][0], json!(["1", null]));
        assert_eq!(g["truncated"], true);
        dispatch(&state, "db_disconnect", json!({"id":id})).unwrap();
        assert!(dispatch(&state, "db_objects", json!({"id":id})).is_err());
    }

    #[test]
    #[ignore = "Requires isolated loopback SSH and MariaDB fixtures"]
    fn network_database_direct_and_verified_ssh() {
        let read_fixture = |key: &str| -> Value {
            serde_json::from_slice(&std::fs::read(std::env::var(key).unwrap()).unwrap()).unwrap()
        };
        let mut db = read_fixture("NEXSSH_TEST_DB_CONNECTION");
        assert_eq!(db["host"], "127.0.0.1");
        let ssh = read_fixture("NEXSSH_TEST_CONNECTION");
        assert_eq!(ssh["hostname"], "127.0.0.1");
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().to_owned()).unwrap();
        let port = ssh["port"].as_u64().unwrap() as u16;
        state.save_config(json!({"hosts":[{"id":"jump","hostname":"127.0.0.1","port":port,"username":ssh["username"],"authMethod":"password"}]})).unwrap();
        crate::security::trust_host(
            &state,
            "jump",
            "127.0.0.1",
            port,
            ssh["fingerprint"].as_str().unwrap(),
        )
        .unwrap();
        crate::ssh::seed_test_credential(&state, "jump", json!({"password":ssh["password"]}));
        let (tx, _rx) = std::sync::mpsc::channel();
        let binding = state.capture_binding("jump").unwrap();
        state.inner.sessions.lock().unwrap().insert(
            "terminal-a".into(),
            crate::storage::TerminalSession {
                host_id: "jump".into(),
                sender: tx,
                binding,
            },
        );
        for route in [None, Some("terminal-a")] {
            db["sshSessionId"] = json!(route);
            let id = dispatch(&state, "db_connect", db.clone()).unwrap()["id"].clone();
            let result = dispatch(
                &state,
                "db_query",
                json!({"id":id,"query":"SELECT 42 AS answer"}),
            )
            .unwrap();
            assert_eq!(result["rows"][0][0], "42");
            let (identity, slow) = match db["engine"].as_str() {
                Some("mariadb" | "mysql") => ("SELECT CONNECTION_ID()", "SELECT SLEEP(12)"),
                Some("postgresql") => ("SELECT pg_backend_pid()", "SELECT pg_sleep(12)"),
                _ => ("", ""),
            };
            if !slow.is_empty() {
                let who = || {
                    dispatch(&state, "db_query", json!({"id":id,"query":identity})).unwrap()["rows"]
                        [0][0]
                        .clone()
                };
                let before = who();
                let pending = state.clone();
                let conn = id.clone();
                let start = std::time::Instant::now();
                let task = std::thread::spawn(move || {
                    dispatch(
                        &pending,
                        "db_query",
                        json!({"id":conn,"query":slow,"requestId":"slow-query"}),
                    )
                });
                std::thread::sleep(Duration::from_millis(300));
                assert_eq!(
                    dispatch(
                        &state,
                        "db_cancel",
                        json!({"id":id,"requestId":"slow-query"})
                    )
                    .unwrap()["cancelled"],
                    true
                );
                assert!(task.join().unwrap().is_err());
                assert!(start.elapsed() < Duration::from_secs(7));
                assert_eq!(who(), before);
            }
            assert!(dispatch(&state, "db_objects", json!({"id":id}))
                .unwrap()
                .is_array());
            dispatch(&state, "db_disconnect", json!({"id":id})).unwrap();
            assert!(state.inner.tunnels.lock().unwrap().is_empty());
        }
    }
}
