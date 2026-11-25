import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Cable, RotateCw, Unplug } from "lucide-react";
import { request, subscribe } from "./api";
import { readClipboardText, writeClipboardText } from "./clipboard";
import { getTerminalTheme } from "./terminalThemes";
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
  appearance: "light" | "dark";
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
  const theme = settings.followAppTheme ? appearance : settings.terminalTheme;

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
    term.options.theme = getTerminalTheme(theme);
    term.options.fontSize = settings.fontSize;
    term.options.fontFamily = settings.fontFamily || "Consolas, monospace";
    term.options.cursorStyle = settings.cursorStyle;
    if (visible && mount.current?.clientWidth) {
      fit.current?.fit();
      term.focus();
    }
  }, [
    visible,
    theme,
    settings.fontSize,
    settings.fontFamily,
    settings.cursorStyle,
  ]);

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
      const onClosed = await subscribe<{ id: string; error: string }>(
        "serial-closed",
        (packet) => {
          if (disposed || packet.id !== id) return;
          ended = true;
          transport.current = null;
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
      setAttempt(0);
      setStatus("Disconnected");
    } catch (e) {
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
      </header>
      <ErrorBox error={error} />
      <div
        ref={mount}
        className="serial-xterm"
        style={{ background: getTerminalTheme(theme).background }}
      />
    </section>
  );
}
