import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";

const PinnedScreenshotWindow = () => {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const pinId = params.get("pin") ?? "";
  const [imageUrl, setImageUrl] = useState("");
  const [error, setError] = useState("");

  const close = useCallback(() => {
    void invoke("close_pinned_screenshot", { pinId }).catch((reason) => setError(String(reason)));
  }, [pinId]);

  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    void invoke<ArrayBuffer>("get_pinned_screenshot", { pinId })
      .then((bytes) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setImageUrl(objectUrl);
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pinId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div
      className="screenshot-pin-root"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button === 0) void getCurrentWindow().startDragging();
      }}
    >
      {imageUrl && <img className="screenshot-pin-image" src={imageUrl} alt="" draggable={false} />}
      <button
        type="button"
        className="screenshot-pin-close"
        title="关闭贴图 (Esc)"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={close}
      >
        <X size={17} />
      </button>
      {error && <div className="screenshot-pin-error">{error}</div>}
    </div>
  );
};

export default PinnedScreenshotWindow;
