import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ExternalLink, Eye, EyeOff, GripVertical, MoreHorizontal, Pin, PinOff, Tag, X } from "lucide-react";
import type { ClipboardItemProps } from "../types";
import { formatSensitivePreview } from "../../../shared/lib/utils";
import { toTauriLocalImageSrc } from "../../../shared/lib/localImageSrc";

type PopupPosition = { left: number; top?: number; bottom?: number; width: number; maxHeight: number };

const positionPopup = (element: HTMLElement, width: number, offsetX = 0): PopupPosition => {
  const rect = element.getBoundingClientRect();
  const preferredLeft = rect.left + offsetX;
  const popupWidth = Math.min(width, window.innerWidth - 20, offsetX ? window.innerWidth - preferredLeft - 10 : width);
  const left = Math.max(10, Math.min(preferredLeft, window.innerWidth - popupWidth - 10));
  const below = window.innerHeight - rect.bottom - 8;
  const above = rect.top - 8;
  const maxHeight = Math.min(window.innerHeight * 0.5, Math.max(below, above));
  if (below < 120 && above > below) {
    return { left, bottom: window.innerHeight - rect.top + 4, width: popupWidth, maxHeight: Math.min(maxHeight, above) };
  }
  return { left, top: rect.bottom + 4, width: popupWidth, maxHeight: Math.min(maxHeight, below) };
};

const SimplifiedClipboardItem = ({
  item,
  id,
  isSelected,
  isSensitiveHidden,
  isRevealed,
  isEditingTags,
  tagInput,
  language,
  t,
  dragControls,
  onSelect,
  onCopy,
  onOpen,
  onTogglePin,
  onDelete,
  onToggleReveal,
  onToggleTagEditor,
  onTagInput,
  onTagAdd,
  onTagDelete
}: ClipboardItemProps) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewPosition, setPreviewPosition] = useState<PopupPosition | null>(null);
  const [menuPosition, setMenuPosition] = useState<PopupPosition | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const date = new Date(item.timestamp);
  const dateTime = `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
  const fullDateTime = date.toLocaleString(language === "en" ? "en-US" : language === "tw" ? "zh-TW" : "zh-CN");
  const masked = isSensitiveHidden ? formatSensitivePreview(item.content, item.content_type) : null;
  const content = masked ?? item.content;
  const isImage = item.content_type === "image";
  const fileNames = item.content.split(/\r?\n/).filter(Boolean).map((path) => path.split(/[\\/]/).pop() || path);
  const rowText = isSensitiveHidden
    ? content
    : isImage
      ? `[${t("type_image")}]`
      : item.content_type === "file"
        ? fileNames.join(", ")
        : content || item.preview || `[${item.content_type}]`;
  const imageSrc = isImage && !isSensitiveHidden
    ? (item.content.startsWith("data:") ? item.content : toTauriLocalImageSrc(item.content) || (item.is_external ? convertFileSrc(item.content) : item.content))
    : null;

  useEffect(() => setImageFailed(false), [item.content]);

  useEffect(() => {
    if (!menuPosition) return;
    const onOutside = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (!rowRef.current?.contains(target) && !popupRef.current?.contains(target)) setMenuPosition(null);
    };
    document.addEventListener("mousedown", onOutside, true);
    return () => document.removeEventListener("mousedown", onOutside, true);
  }, [menuPosition]);

  useEffect(() => {
    if (!previewPosition) return;
    const onWheel = (event: WheelEvent) => {
      const preview = previewRef.current;
      if (!preview || preview.scrollHeight <= preview.clientHeight) return;
      event.preventDefault();
      preview.scrollTop += event.deltaY;
    };
    rowRef.current?.addEventListener("wheel", onWheel, { passive: false });
    const row = rowRef.current;
    return () => row?.removeEventListener("wheel", onWheel);
  }, [previewPosition]);
  const copy = (withFormat: boolean) => {
    setPreviewPosition(null);
    setMenuPosition(null);
    onCopy(withFormat);
    onSelect();
  };
  const menuAction = (event: MouseEvent, action: (event: MouseEvent) => void, keepOpen = false) => {
    event.stopPropagation();
    action(event);
    if (!keepOpen) setMenuPosition(null);
  };

  return (
    <div
      ref={rowRef}
      id={id}
      data-test-clipboard-item
      className={`history-item simplified-item${isSelected ? " selected" : ""}${item.is_pinned ? " pinned" : ""}`}
      onMouseDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, .drag-handle")) return;
        event.preventDefault();
        copy(false);
      }}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("button, input, .drag-handle")) return;
        event.preventDefault();
        copy(true);
      }}
      onMouseEnter={() => {
        if (!menuPosition && rowRef.current) setPreviewPosition(positionPopup(rowRef.current, 420, 112));
      }}
      onMouseLeave={() => setPreviewPosition(null)}
    >
      <time className="simplified-time" dateTime={date.toISOString()} title={fullDateTime}>{dateTime}</time>
      <span className="simplified-content">{rowText.replace(/\s+/g, " ").trim()}</span>
      {item.is_pinned && <Pin className="simplified-pin" size={12} aria-label={t("pinned")} />}
      {dragControls && (
        <span className="simplified-drag drag-handle" title={t("drag_to_reorder")} onPointerDown={(event) => dragControls.start(event)}>
          <GripVertical size={14} />
        </span>
      )}
      <button
        type="button"
        className="simplified-menu-trigger"
        aria-label={t("more_actions")}
        title={t("more_actions")}
        aria-expanded={!!menuPosition}
        onClick={(event) => {
          event.stopPropagation();
          setPreviewPosition(null);
          setMenuPosition(menuPosition ? null : positionPopup(event.currentTarget, 170));
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {previewPosition && !menuPosition && createPortal(
        <div
          ref={previewRef}
          className="simplified-preview"
          data-test-full-preview
          style={previewPosition}
        >
          <div className="simplified-preview-heading">{fullDateTime}</div>
          {imageSrc && !imageFailed
            ? <img src={imageSrc} alt={t("type_image")} onError={() => setImageFailed(true)} />
            : <div className="simplified-preview-text">{imageFailed ? t("image_deleted") : content || item.preview}</div>}
        </div>,
        document.body
      )}
      {menuPosition && createPortal(
        <div ref={popupRef} className="simplified-menu" style={menuPosition}>
          {isSensitiveHidden && <button onClick={(event) => menuAction(event, onToggleReveal)}><Eye size={14} />{t("reveal")}</button>}
          {isRevealed && <button onClick={(event) => menuAction(event, onToggleReveal)}><EyeOff size={14} />{t("hide")}</button>}
          <button onClick={(event) => menuAction(event, onOpen)}><ExternalLink size={14} />{t("open")}</button>
          <button onClick={(event) => menuAction(event, onTogglePin)}>{item.is_pinned ? <PinOff size={14} /> : <Pin size={14} />}{item.is_pinned ? t("unpin") : t("pin")}</button>
          <button onClick={(event) => menuAction(event, onToggleTagEditor, true)}><Tag size={14} />{t("tags")}</button>
          {isEditingTags && (
            <div className="simplified-tag-editor">
              <div className="simplified-tag-list">
                {item.tags?.map((tag) => <button key={tag} title={t("delete")} onClick={(event) => { event.stopPropagation(); onTagDelete(tag); }}>{tag}<X size={12} /></button>)}
              </div>
              <input value={tagInput} onChange={(event) => onTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onTagAdd(); }} aria-label={t("tags")} />
            </div>
          )}
          <button onClick={(event) => menuAction(event, onDelete)}><X size={14} />{t("delete")}</button>
        </div>,
        document.body
      )}
    </div>
  );
};

export default SimplifiedClipboardItem;
