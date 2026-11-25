use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    port: String,
    baud: u32,
    data_bits: u8,
    parity: String,
    stop_bits: u8,
    flow: String,
}

impl Options {
    fn builder(&self) -> Result<serialport::SerialPortBuilder, String> {
        let port = self.port.trim();
        #[cfg(windows)]
        if !port.strip_prefix("COM").is_some_and(|n| {
            !n.is_empty()
                && !n.starts_with('0')
                && n.bytes().all(|v| v.is_ascii_digit())
                && n.parse::<u16>().is_ok()
        }) {
            return Err("Enter a COM port such as COM3.".into());
        }
        #[cfg(not(windows))]
        if !serialport::available_ports()
            .map_err(|e| e.to_string())?
            .iter()
            .any(|p| p.port_name == port)
        {
            return Err("Select an available serial port.".into());
        }
        if !(50..=4_000_000).contains(&self.baud) {
            return Err("Baud rate must be between 50 and 4000000.".into());
        }
        let bits = match self.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => return Err("Choose 5 to 8 data bits.".into()),
        };
        let stop = match self.stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => return Err("Choose 1 or 2 stop bits.".into()),
        };
        let parity = match self.parity.as_str() {
            "none" => Parity::None,
            "even" => Parity::Even,
            "odd" => Parity::Odd,
            _ => return Err("Unsupported parity.".into()),
        };
        let flow = match self.flow.as_str() {
            "none" => FlowControl::None,
            "hardware" => FlowControl::Hardware,
            "software" => FlowControl::Software,
            _ => return Err("Unsupported flow control.".into()),
        };
        Ok(serialport::new(port, self.baud)
            .data_bits(bits)
            .parity(parity)
            .stop_bits(stop)
            .flow_control(flow)
            .timeout(Duration::from_millis(20)))
    }
}

struct Session {
    stopping: Arc<AtomicBool>,
    input: mpsc::SyncSender<Vec<u8>>,
    worker: JoinHandle<()>,
}

impl Session {
    fn stop(self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.worker.join();
    }
}

#[derive(Default)]
pub struct SerialSessions(Mutex<HashMap<Uuid, Session>>);

impl SerialSessions {
    pub fn close_all(&self) {
        if let Ok(mut sessions) = self.0.lock() {
            for (_, session) in sessions.drain() {
                session.stop();
            }
        }
    }
}

fn exchange<P: Read + Write>(
    mut port: P,
    input: mpsc::Receiver<Vec<u8>>,
    stopping: &AtomicBool,
    mut received: impl FnMut(&[u8]),
) -> io::Result<()> {
    let mut buffer = [0u8; 8192];
    while !stopping.load(Ordering::Acquire) {
        for data in input.try_iter().take(16) {
            port.write_all(&data)?;
        }
        match port.read(&mut buffer) {
            Ok(0) => thread::sleep(Duration::from_millis(5)),
            Ok(n) => received(&buffer[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

pub fn dispatch(app: &AppHandle, action: &str, payload: Value) -> Result<Value, String> {
    if action == "serial_ports" {
        let mut names: Vec<_> = serialport::available_ports()
            .map_err(|e| format!("Could not list serial ports: {e}"))?
            .into_iter()
            .map(|p| p.port_name)
            .collect();
        names.sort();
        names.dedup();
        return Ok(json!(names));
    }
    let id = Uuid::parse_str(crate::required(&payload, "id")?)
        .map_err(|_| "Invalid serial session ID.")?;
    let state = app.state::<SerialSessions>();
    let mut sessions = state
        .0
        .lock()
        .map_err(|_| "Serial session storage is unavailable.")?;
    match action {
        "serial_open" => {
            if sessions.contains_key(&id) {
                return Err("This serial session is already open.".into());
            }
            let options: Options =
                serde_json::from_value(payload).map_err(|_| "Incomplete serial settings.")?;
            let port = options.builder()?.open().map_err(|e| format!("Could not open {}: {e}. Check the port, speed, and whether another application is using it.", options.port))?;
            let stopping = Arc::new(AtomicBool::new(false));
            let stop = Arc::clone(&stopping);
            let (tx, rx) = mpsc::sync_channel(128);
            let window = app.clone();
            let worker = thread::Builder::new().name("serial-io".into()).spawn(move || {
                let result = exchange(port, rx, &stop, |bytes| {
                    let _ = window.emit("serial-data", json!({"id": id.to_string(), "data": STANDARD.encode(bytes)}));
                });
                if let Err(error) = result {
                    let _ = window.emit("serial-closed", json!({"id": id.to_string(), "error": format!("Serial connection ended: {error}")}));
                }
            }).map_err(|e| e.to_string())?;
            sessions.insert(
                id,
                Session {
                    stopping,
                    input: tx,
                    worker,
                },
            );
        }
        "serial_write" => {
            let text = crate::required(&payload, "text")?;
            if text.len() > 65536 {
                return Err("Serial input chunk exceeds 64 KiB.".into());
            }
            sessions
                .get(&id)
                .ok_or("Serial port is closed.")?
                .input
                .try_send(text.as_bytes().to_vec())
                .map_err(|e| match e {
                    mpsc::TrySendError::Full(_) => "Serial output buffer is full.",
                    mpsc::TrySendError::Disconnected(_) => "Serial port is closed.",
                })?;
        }
        "serial_close" => {
            if let Some(session) = sessions.remove(&id) {
                session.stop();
            }
        }
        _ => return Err("Unknown serial action.".into()),
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_sends_ordered_input_and_receives_binary_output_before_device_loss() {
        struct Device {
            sent: Vec<u8>,
            first_read: bool,
        }
        impl Write for Device {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                self.sent.extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Read for Device {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.first_read {
                    self.first_read = false;
                    buf[..3].copy_from_slice(&[0, 27, 255]);
                    return Ok(3);
                }
                Err(io::ErrorKind::BrokenPipe.into())
            }
        }
        let (tx, rx) = mpsc::sync_channel(4);
        tx.send(b"hello".to_vec()).unwrap();
        tx.send(vec![13, 10]).unwrap();
        let mut device = Device {
            sent: Vec::new(),
            first_read: true,
        };
        let mut output = Vec::new();
        let result = exchange(&mut device, rx, &AtomicBool::new(false), |data| {
            output.extend_from_slice(data)
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(device.sent, b"hello\r\n");
        assert_eq!(output, [0, 27, 255]);
    }

    #[cfg(windows)]
    #[test]
    fn validates_port_name_and_settings_before_opening() {
        let mut options = Options {
            port: "COM17".into(),
            baud: 115200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow: "none".into(),
        };
        assert!(options.builder().is_ok());
        options.port = "C:/file.txt".into();
        assert!(options.builder().is_err());
        options.port = "COM17".into();
        options.baud = 0;
        assert!(options.builder().is_err());
        options.baud = 9600;
        options.data_bits = 9;
        assert!(options.builder().is_err());
    }
}
