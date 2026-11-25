import {
  useEffect,
  useRef,
  useState,
  forwardRef,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { Dialog, Tooltip } from "radix-ui";
import { X, LoaderCircle, AlertCircle, TerminalSquare } from "lucide-react";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}>(function Button({
  children,
  className = "",
  busy,
  variant = "secondary",
  ...props
}, ref) {
  return (
    <button
      type="button"
      {...props}
      ref={ref}
      aria-busy={busy || undefined}
      disabled={props.disabled || busy}
      className={`button ${variant} ${className}`}
    >
      {busy && <span className="button-busy-indicator" aria-hidden="true"><LoaderCircle size={15} className="spin" /></span>}
      <span className="button-content">{children}</span>
    </button>
  );
});
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton({
  label,
  children,
  ...props
}, ref) {
  return (
    <Tooltip.Provider delayDuration={450} skipDelayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
    <Button
      {...props}
      ref={ref}
      variant="ghost"
      className={`icon-button ${props.className || ""}`}
      title={props.disabled ? label : undefined}
      aria-label={label}
    >
      {children}
    </Button>
        </Tooltip.Trigger>
        <Tooltip.Portal><Tooltip.Content className="ui-tooltip" sideOffset={7} collisionPadding={12}>
          {label}
        </Tooltip.Content></Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
});
export function Modal({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onOpenAutoFocus,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onOpenAutoFocus?: (event: Event) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          className={`modal ${wide ? "wide" : ""}`}
        >
          <header className="modal-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? (
                <Dialog.Description>{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">
                  {title} dialog
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close dialog">
                <X size={19} />
              </IconButton>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        {icon || <TerminalSquare size={29} strokeWidth={1.4} />}
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="error-box" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function Confirm({
  open,
  title,
  description,
  onConfirm,
  onClose,
  danger = false,
  confirmLabel = "Confirm",
}: {
  open: boolean;
  title: string;
  description: string;
  onConfirm: () => Promise<unknown> | unknown;
  onClose: () => void;
  danger?: boolean;
  confirmLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) setError("");
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        cancel.current?.focus();
      }}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title={title}
      description={description}
    >
      {error && (
        <div className="modal-body">
          <ErrorBox error={error} />
        </div>
      )}
      <footer className="modal-footer">
        <Button ref={cancel} onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onConfirm();
              onClose();
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </Button>
      </footer>
    </Modal>
  );
}
export function PageHeader({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="toolbar">{children}</div>
    </header>
  );
}
export const clockDate = (value?: string | number) =>
  value
    ? new Date(
        typeof value === "number" && value < 1e12 ? value * 1000 : value,
      ).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never connected";
