import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

async function boot() {
  // Plain-browser preview during development (no Tauri runtime): mock the backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./devMock");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
}

void boot();
