import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Same embed contract as apps/showboat and apps/27b: the portfolio shell's
// iframe only leaves its loading state once the embedded app says so.
if (window.parent !== window) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.parent.postMessage({ source: "portfolio-embed", type: "ready", id: "elsewhere" }, "*");
    });
  });
}
