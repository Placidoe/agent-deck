import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./product-shell.css";
import "./workflow.css";
import "./appearance.css";
import { applyTheme, readTheme } from "./appearance.js";

// Resolve before first React paint, not in an effect (no blue flash on launch).
let savedTheme = "blue";
try { savedTheme = readTheme(window.localStorage); } catch { /* Restricted preview storage. */ }
applyTheme(savedTheme, document.documentElement);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
