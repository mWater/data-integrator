import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { applyLocale, getSavedLocale } from "./localization.js"
import { ThemeProvider } from "./theme.js"
import "./styles.css"

// Assign the global T before anything renders; App re-applies on locale change.
applyLocale(getSavedLocale())

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
)
