import { useRef, useState, type FormEvent } from "react";
import { request } from "./api";
import { commandSuggestions, type CommandSuggestion } from "./terminalCommands";
import { message, type Session, type Snippet } from "./types";
import { Button } from "./ui";

export function TerminalCommandBar({
  session,
  visible,
  snippets,
  workspaceId,
  notify,
  focusTerminal,
  beginInput,
}: {
  session: Session;
  visible: boolean;
  snippets: Snippet[];
  workspaceId?: string;
  notify: (text: string, error?: boolean) => void;
  focusTerminal: () => void;
  beginInput?: () => (() => void) | undefined;
}) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [showMatches, setShowMatches] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const commandId = "command-" + session.id;
  const listId = "suggestions-" + session.id;
  const choices =
    visible && showMatches
      ? commandSuggestions(
          command,
          snippets,
          history,
          session.hostId,
          workspaceId,
        )
      : [];
  const selected = Math.min(highlight, choices.length - 1);
  const unresolved = /\{\{[^{}]*\}\}/.test(command);
  const disabled = session.status !== "connected";
  function insert(choice: CommandSuggestion) {
    setCommand(choice.command);
    setShowMatches(false);
    input.current?.focus();
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !visible ||
      disabled ||
      unresolved ||
      !command.trim() ||
      pending.current
    )
      return;
    const form = event.currentTarget;
    const draft = command;
    pending.current = true;
    const finishInput = beginInput?.();
    setSending(true);
    setShowMatches(false);
    try {
      await request("ssh_write", { sessionId: session.id, data: draft + "\r" });
      setHistory((items) =>
        [draft, ...items.filter((item) => item !== draft)].slice(0, 100),
      );
      setCommand((value) => (value === draft ? "" : value));
      if (
        form.isConnected &&
        form.contains(document.activeElement) &&
        input.current?.value === draft
      )
        focusTerminal();
    } catch (error) {
      notify(message(error), true);
    } finally {
      finishInput?.();
      pending.current = false;
      setSending(false);
    }
  }
  return (
    <form
      id={"command-composer-" + session.id}
      className="command-composer"
      style={{ display: visible ? "flex" : "none" }}
      onSubmit={(event) => void send(event)}
    >
      <label htmlFor={commandId}>Command</label>
      <div className="terminal-command-field">
        <textarea
          ref={input}
          id={commandId}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={choices.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            choices.length ? listId + "-" + selected : undefined
          }
          aria-describedby={unresolved ? commandId + "-hint" : undefined}
          rows={Math.min(5, command.split("\n").length)}
          value={command}
          placeholder="Type a command or find a snippet…"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onBlur={() => setShowMatches(false)}
          onChange={(event) => {
            setCommand(event.target.value);
            setHighlight(0);
            setShowMatches(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && choices.length) {
              event.preventDefault();
              setShowMatches(false);
            } else if (
              event.key === "Tab" &&
              !event.shiftKey &&
              choices.length
            ) {
              event.preventDefault();
              insert(choices[selected]);
            } else if (
              (event.key === "ArrowDown" || event.key === "ArrowUp") &&
              (choices.length || (!command && history.length))
            ) {
              event.preventDefault();
              setShowMatches(true);
              setHighlight(
                choices.length
                  ? (selected +
                      choices.length +
                      (event.key === "ArrowDown" ? 1 : -1)) %
                      choices.length
                  : 0,
              );
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!event.repeat) event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {unresolved && (
          <small id={commandId + "-hint"} className="command-template-hint">
            Fill in the snippet variables before sending.
          </small>
        )}
        {choices.length > 0 && (
          <div className="terminal-suggestions">
            <div className="terminal-suggestions-caption">
              Suggestions <kbd>Tab to insert</kbd>
            </div>
            <div role="listbox" id={listId} aria-label="Command suggestions">
              {choices.map((item, index) => (
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  id={listId + "-" + index}
                  key={item.command}
                  aria-selected={selected === index}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => insert(item)}
                >
                  <span>{item.name || item.source}</span>
                  <code>{item.command}</code>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <Button
        type="submit"
        disabled={disabled || !command.trim() || unresolved || sending}
      >
        Send
      </Button>
    </form>
  );
}
