import { Component, type ReactNode } from "react";
import { reportDisplayError } from "./diagnostics";
import { Button } from "./ui";

export class WorkspaceBoundary extends Component<
  { children: ReactNode; onRestore: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    reportDisplayError("react", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="workspace-recovery" role="alert">
        <img src="/vexssh.svg" alt="" width={48} height={48} />
        <h1>Workspace display interrupted</h1>
        <p>
          Restore the workspace view to return to your hosts and open sessions.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            this.props.onRestore();
            this.setState({ failed: false });
          }}
        >
          Restore workspace
        </Button>
      </main>
    );
  }
}
