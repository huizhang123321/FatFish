import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}

// No StrictMode: it intentionally double-invokes effects in development, which
// would open two EventSource streams and two transcript fetches per channel
// switch. The app has no state-sync hazards that StrictMode would catch.
createRoot(container).render(<App />);
