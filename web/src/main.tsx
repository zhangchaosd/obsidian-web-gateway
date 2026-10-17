import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./themes.css";
import { applyTheme, storedTheme } from "./theme";

// Apply before the first render so the login page uses the chosen theme too.
applyTheme(storedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
