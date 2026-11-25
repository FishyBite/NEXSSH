use crate::{required, storage::Tunnel, AppState};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::{TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

pub fn dispatch(state: &AppState, action: &str, payload: Value) -> Result<Value, String> {
    match action {
        "tunnels_list" => Ok(Value::Array(
            state
                .inner
                .tunnels
                .lock()
                .map_err(|e| e.to_string())?
                .iter()
                .filter(|(_, t)| t.details["owner"] != "database")
                .map(|(_, t)| t.details.clone())
                .collect(),
        )),
        "tunnels_stop" => {
            let id = required(&payload, "id")?;
            stop_rule(state, id)?;
            Ok(json!({"ok":true}))
        }
        "tunnels_start" => start(state, payload),
        "tunnels_update" => update(state, payload),
        _ => Err("Unknown tunnel action".into()),
    }
}
pub(crate) fn stop_rule(state: &AppState, id: &str) -> Result<(), String> {
    let tunnel = state
        .inner
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id);
    if let Some(mut tunnel) = tunnel {
        tunnel.stop.store(true, Ordering::Relaxed);
        let started = std::time::Instant::now();
        while !tunnel.finished.load(Ordering::Acquire) {
            if started.elapsed() > Duration::from_secs(3) {
                tunnel.details["status"] = json!("stopping");
                state
                    .inner
                    .tunnels
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(id.to_string(), tunnel);
                return Err(
                    "Tunnel is still closing. Retry once its connections have stopped.".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(())
}
fn update(state: &AppState, payload: Value) -> Result<Value, String> {
    let id = required(&payload, "id")?;
    let previous = state
        .inner
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .map(|tunnel| tunnel.details.clone())
        .ok_or("Tunnel no longer exists")?;
    let mut replacement = previous.clone();
    for name in [
        "sessionId",
        "type",
        "bindHost",
        "bindPort",
        "targetHost",
        "targetPort",
    ] {
        if let Some(value) = payload.get(name) {
            replacement[name] = value.clone();
        }
    }
    let same_listener = previous["bindHost"] == replacement["bindHost"]
        && previous["bindPort"] == replacement["bindPort"]
        && (previous["type"] == "remote") == (replacement["type"] == "remote");
    if !same_listener {
        let updated = start(state, replacement)?;
        if let Err(error) = stop_rule(state, id) {
            let _ = stop_rule(state, required(&updated, "id")?);
            return Err(format!(
                "New rule was cancelled because the previous rule is still closing: {error}"
            ));
        }
        return Ok(updated);
    }
    stop_rule(state, id)?;
    match start(state, replacement) {
        Ok(updated) => Ok(updated),
        Err(error) => match start(state, previous) {
            Ok(_) => Err(format!("Unable to update tunnel. The previous rule has been restored. {error}")),
            Err(restore_error) => Err(format!("Unable to update tunnel: {error}. The previous rule could not be restarted: {restore_error}")),
        },
    }
}
fn start(state: &AppState, payload: Value) -> Result<Value, String> {
    start_rule(state, payload, false)
}

pub(crate) fn start_database(state: &AppState, ssh_session: &str, host: &str, port: u16) -> Result<(String, u16), String> {
    let rule = start_rule(state, json!({"sessionId":ssh_session, "type":"local", "bindHost":"127.0.0.1", "bindPort":0, "targetHost":host,"targetPort":port}), true)?;
    let id = required(&rule, "id")?;
    Ok((id.to_owned(), rule["bindPort"].as_u64().ok_or("Database tunnel did not get a listening port")? as u16))
}

fn start_rule(state: &AppState, payload: Value, automatic_port: bool) -> Result<Value, String> {
    let binding = state.session_binding(required(&payload, "sessionId")?)?;
    let host_id = binding.host_id.clone();
    let kind = required(&payload, "type")?.to_string();
    if !["local", "remote", "dynamic"].contains(&kind.as_str()) {
        return Err("Choose local, remote, or dynamic forwarding".into());
    }
    let bind_host = payload["bindHost"]
        .as_str()
        .unwrap_or("127.0.0.1")
        .to_string();
    let bind_port = payload["bindPort"]
        .as_u64()
        .ok_or("Enter a listening port")?;
    if (!automatic_port && bind_port == 0) || bind_port > 65535 {
        return Err("Listening port must be between 1 and 65535".into());
    }
    let target_host = payload["targetHost"]
        .as_str()
        .unwrap_or("127.0.0.1")
        .to_string();
    let target_port = payload["targetPort"].as_u64().unwrap_or(0);
    if kind != "dynamic" && (target_port == 0 || target_port > 65535) {
        return Err("Destination port must be between 1 and 65535".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let mut details = json!({"id":id,"sessionId":payload["sessionId"],"hostId":host_id,"type":kind,"bindHost":bind_host,"bindPort":bind_port,"targetHost":target_host,"targetPort":target_port,"status":"active"});
    if automatic_port {
        details["owner"] = json!("database");
    }
    if kind == "remote" {
        let session = state.open_bound_session(&binding)?;
        let (mut listener, _) = session
            .channel_forward_listen(bind_port as u16, Some(&bind_host), Some(32))
            .map_err(|e| format!("Remote listening port could not be opened: {e}"))?;
        state
            .inner
            .tunnels
            .lock()
            .map_err(|e| e.to_string())?
            .insert(
                id.clone(),
                Tunnel {
                    details: details.clone(),
                    stop: stop.clone(),
                    finished: finished.clone(),
                },
            );
        session.set_blocking(false);
        let stop = stop.clone();
        let finished = finished.clone();
        let state = state.clone();
        let worker_id = id.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok(channel) => {
                        let target_host = target_host.clone();
                        let stop = stop.clone();
                        let session = session.clone();
                        std::thread::spawn(move || {
                            if let Ok(stream) = connect_tcp(&target_host, target_port as u16) {
                                let _ = bridge(stream, channel, stop);
                            }
                            drop(session);
                        });
                    }
                    Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(error) => {
                        mark_error(&state, &worker_id, &error.to_string());
                        break;
                    }
                }
            }
            drop(listener);
            finished.store(true, Ordering::Release);
        });
    } else {
        let listener = TcpListener::bind((bind_host.as_str(), bind_port as u16)).map_err(|e| {
            format!("Cannot bind {bind_host}:{bind_port}. The port may already be in use. {e}")
        })?;
        details["bindPort"] = json!(listener.local_addr().map_err(|e| e.to_string())?.port());
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        state
            .inner
            .tunnels
            .lock()
            .map_err(|e| e.to_string())?
            .insert(
                id.clone(),
                Tunnel {
                    details: details.clone(),
                    stop: stop.clone(),
                    finished: finished.clone(),
                },
            );
        let stop = stop.clone();
        let finished = finished.clone();
        let state = state.clone();
        let worker_id = id.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let state = state.clone();
                        let binding = binding.clone();
                        let target_host = target_host.clone();
                        let kind = kind.clone();
                        let stop = stop.clone();
                        std::thread::spawn(move || {
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                            let destination = if kind == "dynamic" {
                                // Windows accepts with the listener's nonblocking mode.
                                // The greeting and destination arrive in separate messages.
                                if stream.set_nonblocking(false).is_err() {
                                    return;
                                }
                                match socks_request(&mut stream) {
                                    Ok(value) => value,
                                    Err(_) => return,
                                }
                            } else {
                                (target_host, target_port as u16)
                            };
                            let session = match state.open_bound_session(&binding) {
                                Ok(value) => value,
                                Err(_) => return,
                            };
                            match session.channel_direct_tcpip(&destination.0, destination.1, None)
                            {
                                Ok(channel) => {
                                    if kind == "dynamic" {
                                        let _ = stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
                                    }
                                    session.set_blocking(false);
                                    let _ = bridge(stream, channel, stop);
                                }
                                Err(_) => {
                                    if kind == "dynamic" {
                                        let _ = stream.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
                                    }
                                }
                            }
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(error) => {
                        mark_error(&state, &worker_id, &error.to_string());
                        break;
                    }
                }
            }
            drop(listener);
            finished.store(true, Ordering::Release);
        });
    }
    // Opening a remote listener can outlive the SSH tab that requested it.
    // Recheck after publishing so session cleanup covers either ordering.
    if let Err(error) = state.session_binding(required(&payload, "sessionId")?) {
        let _ = stop_rule(state, &id);
        return Err(error);
    }
    Ok(details)
}
fn mark_error(state: &AppState, id: &str, error: &str) {
    if let Ok(mut tunnels) = state.inner.tunnels.lock() {
        if let Some(tunnel) = tunnels.get_mut(id) {
            tunnel.details["status"] = json!("error");
            tunnel.details["error"] = json!(error);
            tunnel.stop.store(true, Ordering::Relaxed);
        }
    }
}
pub(crate) fn stop_for_session(state: &AppState, session_id: &str) {
    if let Ok(mut tunnels) = state.inner.tunnels.lock() {
        tunnels.retain(|_, tunnel| {
            if tunnel.details["sessionId"].as_str() == Some(session_id) {
                tunnel.stop.store(true, Ordering::Relaxed);
                false
            } else {
                true
            }
        });
    }
}
fn connect_tcp(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let address = (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| std::io::Error::other("No destination address"))?;
    TcpStream::connect_timeout(&address, Duration::from_secs(10))
}
fn socks_request(stream: &mut TcpStream) -> std::io::Result<(String, u16)> {
    let invalid = || std::io::Error::other("Unsupported SOCKS request");
    let mut header = [0; 2];
    stream.read_exact(&mut header)?;
    if header[0] != 5 {
        return Err(invalid());
    }
    let mut methods = vec![0; header[1] as usize];
    stream.read_exact(&mut methods)?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 255])?;
        return Err(invalid());
    }
    stream.write_all(&[5, 0])?;
    let mut request = [0; 4];
    stream.read_exact(&mut request)?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        return Err(invalid());
    }
    let host = match request[3] {
        1 => {
            let mut address = [0; 4];
            stream.read_exact(&mut address)?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        3 => {
            let mut length = [0];
            stream.read_exact(&mut length)?;
            let mut address = vec![0; length[0] as usize];
            stream.read_exact(&mut address)?;
            String::from_utf8(address).map_err(|_| invalid())?
        }
        4 => {
            let mut address = [0; 16];
            stream.read_exact(&mut address)?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        _ => return Err(invalid()),
    };
    let mut port = [0; 2];
    stream.read_exact(&mut port)?;
    Ok((host, u16::from_be_bytes(port)))
}
pub(crate) fn bridge(
    mut stream: TcpStream,
    mut channel: ssh2::Channel,
    stop: Arc<AtomicBool>,
) -> std::io::Result<()> {
    stream.set_nonblocking(true)?;
    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    let mut to_remote = VecDeque::new();
    let mut to_local = VecDeque::new();
    let mut buffer = [0; 32768];
    let mut local_eof = false;
    let mut remote_eof = false;
    let mut eof_sent = false;
    let mut local_write_closed = false;
    while !stop.load(Ordering::Relaxed) {
        let mut activity = false;
        // Keep the original input slice stable until libssh2 completes the write.
        if !local_eof && to_remote.is_empty() {
            match stream.read(&mut buffer) {
                Ok(0) => local_eof = true,
                Ok(count) => {
                    to_remote.extend(&buffer[..count]);
                    activity = true
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
        }
        if !remote_eof && to_local.len() < 512 * 1024 {
            match channel.read(&mut buffer) {
                Ok(0) => remote_eof = channel.eof(),
                Ok(count) => {
                    to_local.extend(&buffer[..count]);
                    activity = true
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
        }
        if !to_remote.is_empty() {
            match channel.write(to_remote.make_contiguous()) {
                Ok(count) => {
                    to_remote.drain(..count);
                    activity |= count > 0
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
        }
        if !to_local.is_empty() {
            match stream.write(to_local.make_contiguous()) {
                Ok(count) => {
                    to_local.drain(..count);
                    activity |= count > 0
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
        }
        if local_eof && to_remote.is_empty() && !eof_sent {
            match channel.send_eof() {
                Ok(()) => eof_sent = true,
                Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {}
                Err(error) => return Err(std::io::Error::other(error)),
            }
        }
        if remote_eof && to_local.is_empty() && !local_write_closed {
            let _ = stream.shutdown(std::net::Shutdown::Write);
            local_write_closed = true;
        }
        if local_eof && remote_eof && to_remote.is_empty() && to_local.is_empty() {
            break;
        }
        if !activity {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let _ = channel.close();
    Ok(())
}
