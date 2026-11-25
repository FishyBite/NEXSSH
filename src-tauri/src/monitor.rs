use crate::{required, AppState};
use serde_json::{json, Value};
use std::io::Read;

const SCRIPT: &str = r#"LC_ALL=C; printf 'HOST\n'; hostname; printf 'OS\n'; uname -srm; printf 'UPTIME\n'; cat /proc/uptime; printf 'LOAD\n'; cat /proc/loadavg; printf 'CPU1\n'; head -n 1 /proc/stat; sleep 0.25; printf 'CPU2\n'; head -n 1 /proc/stat; printf 'RAM\n'; cat /proc/meminfo; printf 'DISK\n'; df -Pk /; printf 'NETWORK\n'; cat /proc/net/dev; printf 'PROCESSES\n'; ps -eo pid,comm,pcpu,pmem --sort=-pcpu | head -n 16"#;

pub fn read(state: &AppState, payload: Value) -> Result<Value, String> {
    let session = state.open_session_for(required(&payload, "sessionId")?)?;
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel.exec(SCRIPT).map_err(|e| e.to_string())?;
    let mut output = String::new();
    channel
        .by_ref()
        .take(1024 * 1024)
        .read_to_string(&mut output)
        .map_err(|e| e.to_string())?;
    channel.wait_close().map_err(|e| e.to_string())?;
    parse(&output)
}
fn section<'a>(output: &'a str, name: &str, next: &str) -> Result<&'a str, String> {
    output
        .split_once(&format!("{name}\n"))
        .and_then(|(_, tail)| tail.split_once(&format!("{next}\n")))
        .map(|(value, _)| value.trim())
        .ok_or_else(|| {
            format!("Monitoring requires Linux /proc and standard shell utilities. Missing {name}.")
        })
}
fn cpu_sample(line: &str) -> Result<(u64, u64), String> {
    let values = line
        .split_whitespace()
        .skip(1)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if values.len() < 4 {
        return Err("This server does not expose Linux CPU counters".into());
    }
    let total = values
        .iter()
        .take(8)
        .try_fold(0u64, |sum, value| sum.checked_add(*value))
        .ok_or("CPU counters exceed supported range")?;
    let idle = values[3]
        .checked_add(values.get(4).copied().unwrap_or(0))
        .ok_or("CPU idle counter exceeds supported range")?;
    Ok((total, idle))
}
fn parse(output: &str) -> Result<Value, String> {
    let first = cpu_sample(section(output, "CPU1", "CPU2")?)?;
    let second = cpu_sample(section(output, "CPU2", "RAM")?)?;
    let delta = second.0.saturating_sub(first.0);
    if delta == 0 {
        return Err("Server CPU counters did not advance".into());
    }
    let cpu = (1.0 - second.1.saturating_sub(first.1) as f64 / delta as f64) * 100.0;
    let ram = section(output, "RAM", "DISK")?;
    let memory = |name: &str| -> Result<u64, String> {
        ram.lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .and_then(|value| value.checked_mul(1024))
            .ok_or_else(|| format!("Server did not return {name}"))
    };
    let total = memory("MemTotal:")?;
    let available = memory("MemAvailable:")?;
    let disk = section(output, "DISK", "NETWORK")?
        .lines()
        .last()
        .ok_or("Missing disk data")?
        .split_whitespace()
        .collect::<Vec<_>>();
    if disk.len() < 6 {
        return Err("Unable to parse server disk usage".into());
    }
    let disk_total = disk[1]
        .parse::<u64>()
        .map_err(|e| e.to_string())?
        .checked_mul(1024)
        .ok_or("Disk capacity exceeds supported range")?;
    let disk_used = disk[2]
        .parse::<u64>()
        .map_err(|e| e.to_string())?
        .checked_mul(1024)
        .ok_or("Disk usage exceeds supported range")?;
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in section(output, "NETWORK", "PROCESSES")?.lines() {
        if let Some((interface, values)) = line.split_once(':') {
            if interface.trim() == "lo" {
                continue;
            }
            let values = values.split_whitespace().collect::<Vec<_>>();
            if values.len() >= 9 {
                rx = rx
                    .checked_add(values[0].parse::<u64>().map_err(|e| e.to_string())?)
                    .ok_or("Network counter exceeds supported range")?;
                tx = tx
                    .checked_add(values[8].parse::<u64>().map_err(|e| e.to_string())?)
                    .ok_or("Network counter exceeds supported range")?;
            }
        }
    }
    let load = section(output, "LOAD", "CPU1")?
        .split_whitespace()
        .take(3)
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Invalid server load average: {error}"))?;
    if load.len() != 3 || load.iter().any(|value| !value.is_finite() || *value < 0.0) {
        return Err("Server did not return three valid load averages".into());
    }
    let uptime = section(output, "UPTIME", "LOAD")?
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or("Missing or invalid uptime")?;
    Ok(
        json!({"hostname":section(output,"HOST","OS")?,"os":section(output,"OS","UPTIME")?,"uptime":uptime,"load":load,"cpu":cpu.clamp(0.0,100.0),"ram":{"used":total.saturating_sub(available),"total":total},"disk":{"used":disk_used,"total":disk_total},"network":{"rx":rx,"tx":tx},"processes":output.split_once("PROCESSES\n").map(|(_,value)|value.trim()).unwrap_or("")}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cpu_ignores_guest_counters_already_in_user_time() {
        assert_eq!(
            cpu_sample("cpu 100 10 20 800 20 0 0 50 10 1").unwrap(),
            (1000, 820)
        );
    }
    #[test]
    fn refuses_missing_metrics() {
        assert!(parse("HOST\nserver\nOS\nDarwin").is_err());
    }
    const SAMPLE: &str = "HOST\nfixture\nOS\nLinux 6.8 x86_64\nUPTIME\n1234.5 4567.8\nLOAD\n0.25 0.50 1.00 1/10 100\nCPU1\ncpu 100 10 20 800 20 0 0 50 10 1\nCPU2\ncpu 150 10 40 820 20 0 0 60 10 1\nRAM\nMemTotal: 8192 kB\nMemAvailable: 2048 kB\nDISK\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 10000 5000 5000 50% /\nNETWORK\nInter-| Receive | Transmit\n lo: 50 0 0 0 0 0 0 0 50 0 0 0 0 0 0 0\n eth0: 1200 0 0 0 0 0 0 0 3400 0 0 0 0 0 0 0\nPROCESSES\nPID COMMAND %CPU %MEM\n1 init 0 0\n";
    #[test]
    fn parses_counter_format_and_units() {
        let sample = parse(SAMPLE).unwrap();
        assert_eq!(sample["hostname"], "fixture");
        assert_eq!(sample["cpu"], 80.0);
        assert_eq!(sample["ram"]["total"], 8192 * 1024);
        assert_eq!(sample["ram"]["used"], 6144 * 1024);
        assert_eq!(sample["disk"]["used"], 5000 * 1024);
        assert_eq!(sample["network"]["rx"], 1200);
        assert_eq!(sample["network"]["tx"], 3400);
        assert_eq!(sample["load"], json!([0.25, 0.5, 1.0]));
    }
    #[test]
    fn malformed_or_missing_load_is_an_error() {
        assert!(parse(&SAMPLE.replace("0.25 0.50 1.00", "unavailable 0.50 1.00")).is_err());
        assert!(parse(&SAMPLE.replace("0.25 0.50 1.00 1/10 100", "0.25")).is_err());
        assert!(parse(&SAMPLE.replace("0.25 0.50 1.00", "NaN 0.50 1.00")).is_err());
    }
    #[test]
    fn incomplete_memory_sample_is_an_error() {
        assert!(parse(&SAMPLE.replace("MemAvailable: 2048 kB\n", "")).is_err());
    }
}
