import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App.tsx"
import "./index.css"

const root = document.getElementById("root")!

createRoot(root).render(
  <StrictMode>
    <App
      initialQuery={root.dataset.query ?? ""}
      upstreamHost={root.dataset.upstream ?? ""}
    />
  </StrictMode>,
)
