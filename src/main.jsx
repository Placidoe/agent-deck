import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./product-shell.css";
import "./workflow.css";
import "./appearance.css";
import { initializeAppearance } from "./appearance.js";

// Resolve before first React paint, not in an effect (no blue flash on launch).
let appearanceStorage;
try { appearanceStorage = window.localStorage; } catch { /* Restricted preview storage. */ }
const disposeAppearance = initializeAppearance({ root: document.documentElement, storage: appearanceStorage,
  media: window.matchMedia("(prefers-color-scheme: dark)"), events: window });
if (import.meta.hot) import.meta.hot.dispose(disposeAppearance);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
