import { Component, type ReactNode } from "react";
import { Button } from "./ui";

export class TerminalViewBoundary extends Component<
  { children: ReactNode; visible: boolean; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section
        className="empty-state"
        style={{ display: this.props.visible ? "flex" : "none" }}
        role="alert"
      >
        <h2>Terminal display interrupted</h2>
        <p>Retry this view to continue with the existing SSH sessions.</p>
        <Button
          onClick={() => {
            this.props.onRetry();
            this.setState({ failed: false });
          }}
        >
          Retry terminal view
        </Button>
      </section>
    );
  }
}
