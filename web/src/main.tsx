import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/jost";
import App from "./App";
import { FeedbackProvider } from "./lib/toast";
import "./index.css";
import { initA11y } from "./lib/a11y";

initA11y(); // apply the saved text size and contrast before the first screen draws

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <FeedbackProvider>
        <App />
      </FeedbackProvider>
    </BrowserRouter>
  </StrictMode>,
);
