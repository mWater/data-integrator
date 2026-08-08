import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { ThemeProvider } from "./theme.js"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
)
