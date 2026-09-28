import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CompactPreviewWindow from "./features/clipboard/components/CompactPreviewWindow";
import AdvancedSettingsWindow from "./features/settings/components/AdvancedSettingsWindow";
import ScreenshotOverlayWindow from "./features/screenshot/components/ScreenshotOverlayWindow";
import PinnedScreenshotWindow from "./features/screenshot/components/PinnedScreenshotWindow";
import "./index.css";
import "./styles/components/index.css";
import "./styles/themes/load";
import "./styles/window-elevation.css";

const params = new URLSearchParams(window.location.search);
const isCompactPreview = params.get("window") === "compact-preview";
const isAdvancedSettingsWindow = params.get("window") === "advanced-settings";
const isScreenshotOverlay = params.get("window") === "screenshot-overlay";
const isPinnedScreenshot = params.get("window") === "screenshot-pin";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isCompactPreview
      ? <CompactPreviewWindow />
      : isPinnedScreenshot
        ? <PinnedScreenshotWindow />
        : isScreenshotOverlay
          ? <ScreenshotOverlayWindow />
          : isAdvancedSettingsWindow
            ? <AdvancedSettingsWindow />
            : <App />}
  </React.StrictMode>,
);
