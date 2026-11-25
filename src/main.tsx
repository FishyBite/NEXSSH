import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDisplayDiagnostics } from "./diagnostics";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import "./polish.css";
const removeDisplayDiagnostics = installDisplayDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(removeDisplayDiagnostics);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
