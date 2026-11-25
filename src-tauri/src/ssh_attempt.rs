use crate::{storage::TerminalCommand, AppState};
use serde_json::{json, Value};
use std::{
    net::{Shutdown, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};

const CANCELLED: &str = "SSH connection cancelled";

#[derive(Default)]
struct Transport {
    cancelled: bool,
    dialing: Option<tokio::task::AbortHandle>,
    sockets: Vec<TcpStream>,
}

#[derive(Default)]
pub struct Attempt(Mutex<Transport>);

impl Attempt {
    pub fn check(&self) -> Result<(), String> {
        if self.0.lock().map_err(|e| e.to_string())?.cancelled {
            return Err(CANCELLED.into());
        }
        Ok(())
    }

    pub fn dial(&self, hostname: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
        let address = hostname.to_owned();
        tauri::async_runtime::block_on(async {
            let task = {
                let mut transport = self.0.lock().map_err(|e| e.to_string())?;
                if transport.cancelled {
                    return Err(CANCELLED.into());
                }
                let task = tokio::spawn(async move {
                    tokio::time::timeout(
                        timeout,
                        tokio::net::TcpStream::connect((address.as_str(), port)),
                    )
                    .await
                });
                transport.dialing = Some(task.abort_handle());
                task
            };
            let connection = task.await;
            let mut transport = self.0.lock().map_err(|e| e.to_string())?;
            transport.dialing = None;
            if transport.cancelled {
                return Err(CANCELLED.into());
            }
            let socket = connection
                .map_err(|e| e.to_string())?
                .map_err(|_| format!("Connection to {hostname}:{port} timed out"))?
                .map_err(|e| format!("Cannot connect to {hostname}:{port}: {e}"))?
                .into_std()
                .map_err(|e| e.to_string())?;
            socket.set_nonblocking(false).map_err(|e| e.to_string())?;
            Ok(socket)
        })
    }

    pub fn track(&self, stream: &TcpStream) -> Result<(), String> {
        let mut transport = self.0.lock().map_err(|e| e.to_string())?;
        if transport.cancelled {
            return Err(CANCELLED.into());
        }
        transport
            .sockets
            .push(stream.try_clone().map_err(|e| e.to_string())?);
        Ok(())
    }

    pub fn cancel(&self) {
        if let Ok(mut transport) = self.0.lock() {
            transport.cancelled = true;
            if let Some(task) = transport.dialing.take() {
                task.abort();
            }
            for socket in transport.sockets.drain(..) {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
}

pub fn begin(state: &AppState, id: &str) -> Result<Value, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid SSH connection attempt")?;
    let mut attempts = state.inner.ssh_attempts.lock().map_err(|e| e.to_string())?;
    if attempts.contains_key(id)
        || state
            .inner
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .contains_key(id)
    {
        return Err("SSH connection attempt already exists".into());
    }
    attempts.insert(id.into(), Arc::new(Attempt::default()));
    Ok(json!({"ok":true}))
}

pub fn cancel(state: &AppState, id: &str) -> Result<Value, String> {
    if let Some(attempt) = state
        .inner
        .ssh_attempts
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
    {
        attempt.cancel();
    }
    // A terminal can finish opening while its IPC response is in flight.
    if let Some(session) = state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
    {
        let _ = session.sender.send(TerminalCommand::Close);
    }
    Ok(json!({"ok":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpListener};

    #[test]
    fn cancel_releases_connected_socket_and_prevents_redial() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let attempt = Attempt::default();
        let socket = attempt
            .dial("127.0.0.1", port, Duration::from_secs(2))
            .unwrap();
        attempt.track(&socket).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        attempt.cancel();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(server.read(&mut [0; 1]).unwrap(), 0);
        assert_eq!(
            attempt
                .dial("127.0.0.1", port, Duration::from_secs(1))
                .unwrap_err(),
            CANCELLED
        );
        assert!(attempt.track(&socket).is_err());
    }
}
