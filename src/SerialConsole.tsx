import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Cable, Circle, RotateCw, Square, Unplug } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { request, subscribe } from "./api";
import { readClipboardText, writeClipboardText } from "./clipboard";
import { getTerminalTheme } from "./terminalThemes";
import { applyTerminalFont } from "./applyTerminalFont";
import {
  serialFraming,
  serialInput,
  type SerialProfile,
} from "./serialProfile";
import { message, type Settings } from "./types";
import { Button, ErrorBox } from "./ui";

type Status = "Connecting" | "Connected" | "Disconnected";

export default function SerialConsole({
  profile,
  visible,
  settings,
  appearance,
}: {
  profile: SerialProfile;
  visible: boolean;
  settings: Settings;
  appearance: Settings["terminalTheme"];
}) {
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const transport = useRef<string | null>(null);
  const copyOnSelect = useRef(settings.copyOnSelect);
  copyOnSelect.current = settings.copyOnSelect;
  const [status, setStatus] = useState<Status>("Connecting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(1);
  const recording = useRef<{ id: string; path: string; started: boolean } | null>(null);
  const changingRecording = useRef(false);
  const [recordingPath, setRecordingPath] = useState("");
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [savedLog, setSavedLog] = useState("");
  const [logError, setLogError] = useState("");
  const theme = settings.followAppTheme ? appearance : settings.terminalTheme;

  function finishRecording(saved: boolean) {
    if (saved && recording.current?.started) setSavedLog(recording.current.path);
    recording.current = null;
    setRecordingPath("");
  }

  async function toggleRecording() {
    const id = transport.current;
    if (!id || changingRecording.current) return;
    changingRecording.current = true;
    setRecordingBusy(true);
    setLogError("");
    const current = recording.current;
    try {
      if (current) {
        await request("serial_record_stop", { id, recordingId: current.id });
        if (recording.current === current) finishRecording(true);
      } else {
        const stamp = new Date().toISOString().replace(/:/g, "-");
        const path = await saveDialog({
          title: "Save timestamped Serial log",
          defaultPath: `${profile.port}-${stamp}.log`,
          filters: [{ name: "Serial log", extensions: ["log", "txt"] }],
        });
        if (!path || transport.current !== id || !mount.current?.offsetWidth) return;
        const next = { id: crypto.randomUUID(), path, started: false };
        recording.current = next;
        setSavedLog("");
        await request("serial_record_start", { id, recordingId: next.id, path });
        if (transport.current === id && recording.current === next) {
          next.started = true;
          setRecordingPath(path);
        }
      }
    } catch (e) {
      if (transport.current === id) {
        if (!current) finishRecording(false);
        setLogError(message(e));
      }
    } finally {
      changingRecording.current = false;
      setRecordingBusy(false);
      if (transport.current === id && mount.current?.offsetWidth && !document.querySelector('[role="dialog"]')) terminal.current?.focus();
    }
  }

  useEffect(() => {
    const container = mount.current!;
    const term = new Terminal({
      allowProposedApi: false,
      scrollback: 5000,
      cursorBlink: true,
      convertEol: true,
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(container);
    terminal.current = term;
    fit.current = addon;
    const resize = () => {
      if (container.clientWidth && container.clientHeight) addon.fit();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    const paste = async () => {
      const id = transport.current;
      if (!id) return;
      try {
        const data = await readClipboardText();
        if (transport.current === id && terminal.current === term && container.offsetWidth) {
          term.paste(data);
          term.focus();
        }
      } catch (e) {
        setError(message(e));
      }
    };
    const copy = () => {
      const selection = term.getSelection();
      if (selection)
        void writeClipboardText(selection).catch((e) => setError(message(e)));
    };
    const onContext = (event: MouseEvent) => {
      event.preventDefault();
      void paste();
    };
    const onSelect = (event: PointerEvent) => {
      if (event.button === 0 && copyOnSelect.current) copy();
    };
    container.addEventListener("contextmenu", onContext);
    container.addEventListener("pointerup", onSelect);
    term.attachCustomKeyEventHandler((e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        if (e.type === "keydown") copy();
      } else if (key === "v") {
        if (e.type === "keydown") void paste();
      } else return true;
      e.preventDefault();
      return false;
    });
    return () => {
      observer.disconnect();
      container.removeEventListener("contextmenu", onContext);
      container.removeEventListener("pointerup", onSelect);
      terminal.current = null;
      fit.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    return applyTerminalFont(term, settings.fontFamily, settings.fontSize, () => {
      if (mount.current?.clientWidth && mount.current.clientHeight) fit.current?.fit();
    });
  }, [settings.fontFamily, settings.fontSize]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.theme = getTerminalTheme(theme, settings.terminalForeground);
    term.options.cursorStyle = settings.cursorStyle;
  }, [theme, settings.terminalForeground, settings.cursorStyle]);

  useEffect(() => {
    if (visible && mount.current?.clientWidth && terminal.current) {
      fit.current?.fit();
      terminal.current.focus();
    }
  }, [visible]);

  useEffect(() => {
    if (!attempt) return;
    const term = terminal.current!;
    const id = crypto.randomUUID();
    let disposed = false,
      ended = false,
      opening = false;
    const listeners: (() => void)[] = [];
    let writes = Promise.resolve();
    const close = () => request("serial_close", { id }).catch(() => {});
    setStatus("Connecting");
    setError("");
    const input = term.onData((data) => {
      if (transport.current !== id || !data) return;
      const text = serialInput(data, profile.enter);
      writes = writes
        .then(async () => {
          for (const [chunk] of text.matchAll(/[\s\S]{1,8192}/gu)) {
            if (disposed || transport.current !== id) return;
            await request("serial_write", { id, text: chunk });
            if (profile.localEcho && !disposed) term.write(chunk);
          }
        })
        .catch((e) => {
          if (!disposed) setError(message(e));
        });
    });
    const connect = async () => {
      const onData = await subscribe<{ id: string; data: string }>(
        "serial-data",
        (packet) => {
          if (!disposed && packet.id === id)
            term.write(
              Uint8Array.from(atob(packet.data), (c) => c.charCodeAt(0)),
            );
        },
      );
      if (disposed) {
        onData();
        return;
      }
      listeners.push(onData);
      const onRecordError = await subscribe<{ id: string; recordingId: string; error: string }>(
        "serial-record-error", packet => {
          if (!disposed && packet.id === id && packet.recordingId === recording.current?.id) {
            finishRecording(false);
            setLogError(packet.error);
          }
        },
      );
      if (disposed) { onRecordError(); return; }
      listeners.push(onRecordError);
      const onClosed = await subscribe<{ id: string; error: string; recordingError?: string }>(
        "serial-closed",
        (packet) => {
          if (disposed || packet.id !== id) return;
          ended = true;
          transport.current = null;
          finishRecording(!packet.recordingError);
          if (packet.recordingError) setLogError(packet.recordingError);
          setStatus("Disconnected");
          setError(packet.error);
          void close();
        },
      );
      if (disposed) {
        onClosed();
        return;
      }
      listeners.push(onClosed);
      opening = true;
      await request("serial_open", { ...profile, id });
      if (disposed || ended) {
        await close();
        return;
      }
      transport.current = id;
      setStatus("Connected");
      if (
        mount.current?.offsetWidth &&
        !document.querySelector('[role="dialog"]')
      )
        term.focus();
    };
    void connect().catch((e) => {
      if (!disposed) {
        setError(message(e));
        setStatus("Disconnected");
      }
    });
    return () => {
      disposed = true;
      transport.current = null;
      recording.current = null;
      listeners.forEach((remove) => remove());
      input.dispose();
      if (opening) void close();
    };
  }, [attempt, profile]);

  const disconnect = async () => {
    const id = transport.current;
    if (!id) return;
    transport.current = null;
    try {
      await request("serial_close", { id });
      finishRecording(true);
      setAttempt(0);
      setStatus("Disconnected");
    } catch (e) {
      finishRecording(false);
      setAttempt(0);
      setError(message(e));
      setStatus("Disconnected");
    }
  };
  return (
    <section
      hidden={!visible}
      className="serial-console"
      aria-label={"Serial terminal " + profile.port}
    >
      <header>
        <div>
          <Cable size={17} />
          <strong>{profile.port}</strong>
          <span>
            {profile.baud} bps · {serialFraming(profile)}
          </span>
          <span role="status">{status}</span>
        </div>
        <div className="serial-console-actions">
          {status === "Connected" && <Button onClick={() => void toggleRecording()} busy={recordingBusy}
            aria-pressed={!!recordingPath} title={recordingPath || "Save received device output with UTC timestamps"}>
            {recordingPath ? <Square size={14} /> : <Circle size={14} />}
            {recordingPath ? "Stop recording" : "Record log"}
          </Button>}
          {status === "Disconnected" ? (
            <Button onClick={() => setAttempt((n) => n + 1)}>
              <RotateCw size={15} />
              Reconnect
            </Button>
          ) : (
            <Button
              disabled={status !== "Connected"}
              onClick={() => void disconnect()}
            >
              <Unplug size={15} />
              Disconnect
            </Button>
          )}
        </div>
      </header>
      {(recordingPath || savedLog) && <div className="serial-recording-note" aria-live="polite">
        {recordingPath ? "Recording to " : "Log saved to "}<span>{recordingPath || savedLog}</span>
      </div>}
      <ErrorBox error={logError} />
      <ErrorBox error={error} />
      <div
        ref={mount}
        className="serial-xterm"
        style={{ background: getTerminalTheme(theme).background }}
      />
    </section>
  );
}
