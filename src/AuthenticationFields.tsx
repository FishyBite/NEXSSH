import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { KeyRound } from "lucide-react";
import { request } from "./api";
import { Field, Button, ErrorBox } from "./ui";
import { message, type Host, type KeyInfo } from "./types";
import {
  authenticationChoice,
  changeAuthentication,
  type AuthenticationChoice,
  type IdentityInspection,
} from "./authentication";

export interface InspectionState {
  value: IdentityInspection | null;
  loading: boolean;
  error: string;
}
export function AuthenticationFields({
  host,
  onChange,
  disabled = false,
  onInspection,
}: {
  host: Host;
  onChange: (host: Host) => void;
  disabled?: boolean;
  onInspection?: (state: InspectionState) => void;
}) {
  const choice = authenticationChoice(host);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [inspection, setInspection] = useState<InspectionState>({
    value: null,
    loading: false,
    error: "",
  });
  const [keyError, setKeyError] = useState("");
  useEffect(() => {
    if (choice !== "saved-key") return;
    let active = true;
    void request<KeyInfo[]>("keys_list")
      .then((items) => {
        if (active) {
          setKeys(items);
          setKeyError("");
        }
      })
      .catch((error) => {
        if (active) setKeyError(message(error));
      });
    return () => {
      active = false;
    };
  }, [choice]);
  useEffect(() => {
    let active = true;
    const update = (state: InspectionState) => {
      if (active) {
        setInspection(state);
        onInspection?.(state);
      }
    };
    const inspectionPayload =
      choice === "private-key" && host.identityFile?.trim()
        ? { path: host.identityFile }
        : choice === "saved-key" && host.keyId
          ? { keyId: host.keyId }
          : null;
    if (!inspectionPayload) {
      update({ value: null, loading: false, error: "" });
      return;
    }
    update({ value: null, loading: true, error: "" });
    const timer = window.setTimeout(() => {
      void request<IdentityInspection>("identity_inspect", inspectionPayload)
        .then((value) => update({ value, loading: false, error: "" }))
        .catch((error) =>
          update({ value: null, loading: false, error: message(error) }),
        );
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [choice, host.identityFile, host.keyId]);
  const browse = async () => {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title: "Choose OpenSSH private key",
        defaultPath: host.identityFile || undefined,
      });
      if (path)
        onChange({
          ...host,
          identityFile: path,
          keyId: undefined,
          keySource: "file",
          authMethod: "key",
        });
    } catch (error) {
      setInspection({ value: null, loading: false, error: message(error) });
    }
  };
  return (
    <>
      <Field label="Authentication">
        <select
          value={choice}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              changeAuthentication(
                host,
                event.target.value as AuthenticationChoice,
              ),
            )
          }
        >
          <option value="password">Password</option>
          <option value="private-key">Private key</option>
          <option value="saved-key">Saved SSH key</option>
          <option value="agent">SSH agent</option>
        </select>
      </Field>
      {choice === "private-key" && (
        <div className="span-2">
          <Field
            label="Private key file"
            hint="Choose a local OpenSSH Ed25519 or RSA private key. The host profile saves the file path."
          >
            <div className="input-action">
              <input
                required
                disabled={disabled}
                value={host.identityFile || ""}
                onChange={(event) =>
                  onChange({
                    ...host,
                    identityFile: event.target.value,
                    keyId: undefined,
                  })
                }
                placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                autoComplete="off"
              />
              <Button disabled={disabled} onClick={() => void browse()}>
                Browse
              </Button>
            </div>
          </Field>
          {inspection.loading && (
            <p className="field-note" role="status">
              Checking private key format…
            </p>
          )}
          {inspection.value && (
            <p className="identity-inspection">
              <KeyRound size={14} />
              {inspection.value.algorithm.toUpperCase()} ·{" "}
              {inspection.value.encrypted
                ? "Encrypted key · passphrase requested after server verification"
                : "Unencrypted key · ready to authenticate"}
            </p>
          )}
          <ErrorBox error={inspection.error} />
        </div>
      )}
      {choice === "saved-key" && (
        <>
          <Field label="Saved SSH key">
            <select
              required
              disabled={disabled}
              value={host.keyId || ""}
              onChange={(event) =>
                onChange({
                  ...host,
                  keyId: event.target.value,
                  identityFile: undefined,
                })
              }
            >
              <option value="">Select a saved key</option>
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorBox error={keyError} />
          <ErrorBox error={inspection.error} />
        </>
      )}
    </>
  );
}
