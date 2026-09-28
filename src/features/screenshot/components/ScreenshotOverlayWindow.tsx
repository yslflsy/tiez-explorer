import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpRight,
  Check,
  Circle,
  Download,
  Grid3X3,
  GripVertical,
  MousePointer2,
  PaintBucket,
  Pencil,
  Pin,
  Redo2,
  Square,
  Type,
  Undo2,
  X
} from "lucide-react";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
type Tool = "select" | "rect" | "ellipse" | "arrow" | "pen" | "mosaic" | "text";
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Annotation =
  | { type: "rect" | "ellipse" | "arrow" | "mosaic"; start: Point; end: Point; color: string; width: number }
  | { type: "pen"; points: Point[]; color: string; width: number }
  | { type: "text"; point: Point; text: string; color: string; width: number; fontSize: number; backgroundColor: string | null };

type TextAnnotation = Extract<Annotation, { type: "text" }>;

interface MonitorPayload {
  sessionId: string;
  monitorIndex: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

type DragState =
  | { mode: "new"; start: Point }
  | { mode: "move"; start: Point; original: Rect }
  | { mode: "move-region"; start: Point; original: Rect; offset: Point }
  | { mode: "resize"; start: Point; original: Rect; handle: ResizeHandle }
  | { mode: "draw"; start: Point }
  | { mode: "text"; point: Point }
  | { mode: "move-text"; start: Point; original: Point; annotationIndex: number };

const HANDLE_SIZE = 8;
const MIN_SELECTION = 4;

const rectFromPoints = (start: Point, end: Point): Rect => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y)
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const pointInRect = (point: Point, rect: Rect) =>
  point.x >= rect.x && point.x <= rect.x + rect.width &&
  point.y >= rect.y && point.y <= rect.y + rect.height;

const normalizedRect = (annotation: Extract<Annotation, { start: Point }>) =>
  rectFromPoints(annotation.start, annotation.end);

const translateAnnotation = (annotation: Annotation, offset: Point): Annotation => {
  const translate = (point: Point) => ({ x: point.x + offset.x, y: point.y + offset.y });
  if (annotation.type === "pen") return { ...annotation, points: annotation.points.map(translate) };
  if (annotation.type === "text") return { ...annotation, point: translate(annotation.point) };
  return { ...annotation, start: translate(annotation.start), end: translate(annotation.end) };
};

const getTextBounds = (ctx: CanvasRenderingContext2D, annotation: TextAnnotation): Rect => {
  ctx.save();
  ctx.font = `600 ${annotation.fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  const lines = annotation.text.split("\n");
  const padding = 6;
  const width = Math.max(1, ...lines.map((line) => ctx.measureText(line || " ").width));
  const height = Math.max(1, lines.length) * annotation.fontSize * 1.35;
  ctx.restore();
  return {
    x: annotation.point.x - padding,
    y: annotation.point.y - padding,
    width: width + padding * 2,
    height: height + padding * 2
  };
};

const findTextAnnotationIndex = (
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  point: Point
) => {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (annotation.type === "text" && pointInRect(point, getTextBounds(ctx, annotation))) return index;
  }
  return -1;
};

const getResizeHandle = (point: Point, rect: Rect): ResizeHandle | null => {
  const tolerance = 7;
  const left = Math.abs(point.x - rect.x) <= tolerance;
  const right = Math.abs(point.x - rect.x - rect.width) <= tolerance;
  const top = Math.abs(point.y - rect.y) <= tolerance;
  const bottom = Math.abs(point.y - rect.y - rect.height) <= tolerance;
  const withinX = point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance;
  const withinY = point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance;
  if (!withinX || !withinY) return null;
  if (top && left) return "nw";
  if (top && right) return "ne";
  if (bottom && right) return "se";
  if (bottom && left) return "sw";
  if (top) return "n";
  if (right) return "e";
  if (bottom) return "s";
  if (left) return "w";
  return null;
};

const resizeCursors: Record<ResizeHandle, string> = {
  nw: "nwse-resize", n: "ns-resize", ne: "nesw-resize", e: "ew-resize",
  se: "nwse-resize", s: "ns-resize", sw: "nesw-resize", w: "ew-resize"
};

const drawArrow = (ctx: CanvasRenderingContext2D, start: Point, end: Point, color: string, width: number) => {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const head = Math.max(10, width * 4);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
};

const drawMosaic = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  rect: Rect,
  viewportWidth: number,
  viewportHeight: number,
  strength: number
) => {
  if (rect.width < 1 || rect.height < 1) return;
  const sourceScaleX = image.naturalWidth / viewportWidth;
  const sourceScaleY = image.naturalHeight / viewportHeight;
  const block = Math.max(4, Math.round(strength * 2));
  const scratch = document.createElement("canvas");
  scratch.width = Math.max(1, Math.round(rect.width / block));
  scratch.height = Math.max(1, Math.round(rect.height / block));
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) return;
  scratchCtx.drawImage(
    image,
    rect.x * sourceScaleX,
    rect.y * sourceScaleY,
    rect.width * sourceScaleX,
    rect.height * sourceScaleY,
    0,
    0,
    scratch.width,
    scratch.height
  );
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
};

const drawAnnotation = (
  ctx: CanvasRenderingContext2D,
  annotation: Annotation,
  image: HTMLImageElement,
  viewportWidth: number,
  viewportHeight: number
) => {
  ctx.save();
  ctx.strokeStyle = annotation.color;
  ctx.fillStyle = annotation.color;
  ctx.lineWidth = annotation.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (annotation.type === "pen") {
    if (annotation.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(annotation.points[0].x, annotation.points[0].y);
      annotation.points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.stroke();
    }
  } else if (annotation.type === "text") {
    const bounds = getTextBounds(ctx, annotation);
    if (annotation.backgroundColor) {
      ctx.fillStyle = annotation.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, 6);
      ctx.fill();
    }
    ctx.fillStyle = annotation.color;
    ctx.font = `600 ${annotation.fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = "top";
    annotation.text.split("\n").forEach((line, index) => {
      ctx.fillText(line, annotation.point.x, annotation.point.y + index * annotation.fontSize * 1.35);
    });
  } else if (annotation.type === "arrow") {
    drawArrow(ctx, annotation.start, annotation.end, annotation.color, annotation.width);
  } else if (annotation.type === "mosaic") {
    drawMosaic(ctx, image, normalizedRect(annotation), viewportWidth, viewportHeight, annotation.width);
  } else {
    const rect = normalizedRect(annotation);
    ctx.beginPath();
    if (annotation.type === "ellipse") {
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2
      );
    } else {
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.stroke();
  }
  ctx.restore();
};

const ToolbarButton = ({
  title,
  active = false,
  disabled = false,
  className = "",
  onClick,
  children
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    className={`screenshot-tool-button ${active ? "active" : ""} ${className}`}
    title={title}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
);

const ScreenshotOverlayWindow = () => {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("session") ?? "";
  const monitorIndex = Number(params.get("monitor") ?? "0");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const colorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [payload, setPayload] = useState<MonitorPayload | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageReady, setImageReady] = useState(false);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [sizeDraft, setSizeDraft] = useState<{ width: string; height: string } | null>(null);
  const [regionDragging, setRegionDragging] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#ff3b30");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [fontSize, setFontSize] = useState(24);
  const [textBackgroundEnabled, setTextBackgroundEnabled] = useState(false);
  const [textBackgroundColor, setTextBackgroundColor] = useState("#ffffff");
  const [selectedTextIndex, setSelectedTextIndex] = useState<number | null>(null);
  const [hoverTextIndex, setHoverTextIndex] = useState<number | null>(null);
  const [hoverHandle, setHoverHandle] = useState<ResizeHandle | null>(null);
  const [hoverColor, setHoverColor] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [textEditor, setTextEditor] = useState<{ point: Point; value: string; annotationIndex: number | null } | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sourceWidth = payload?.width ?? viewport.width;
  const sourceHeight = payload?.height ?? viewport.height;
  const selectionPixelWidth = Math.round((selection?.width ?? 0) * sourceWidth / viewport.width);
  const selectionPixelHeight = Math.round((selection?.height ?? 0) * sourceHeight / viewport.height);

  const applySelectionSize = () => {
    if (!selection || !sizeDraft || busy) return false;
    const width = Number(sizeDraft.width);
    const height = Number(sizeDraft.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > sourceWidth || height > sourceHeight) {
      setError(`请输入有效的整数尺寸：宽 1-${sourceWidth}，高 1-${sourceHeight}`);
      return false;
    }
    const scaleX = sourceWidth / viewport.width;
    const scaleY = sourceHeight / viewport.height;
    setSelection({
      x: clamp(Math.round(selection.x * scaleX), 0, sourceWidth - width) / scaleX,
      y: clamp(Math.round(selection.y * scaleY), 0, sourceHeight - height) / scaleY,
      width: width / scaleX,
      height: height / scaleY
    });
    setSizeDraft(null);
    setError("");
    return true;
  };

  const updateSelectedText = useCallback((updates: Partial<TextAnnotation>) => {
    if (selectedTextIndex === null) return;
    setAnnotations((current) => current.map((annotation, index) =>
      index === selectedTextIndex && annotation.type === "text"
        ? { ...annotation, ...updates }
        : annotation
    ));
    setRedoStack([]);
  }, [selectedTextIndex]);

  useEffect(() => {
    let disposed = false;
    let objectUrl = "";

    const loadScreenshot = async () => {
      const [monitor, imageBytes] = await Promise.all([
        invoke<MonitorPayload>("get_screenshot_monitor", { sessionId, monitorIndex }),
        invoke<ArrayBuffer>("get_screenshot_image", { sessionId, monitorIndex })
      ]);
      if (disposed) return;
      objectUrl = URL.createObjectURL(new Blob([imageBytes], { type: "image/png" }));
      setPayload(monitor);
      setImageUrl(objectUrl);
    };

    void loadScreenshot().catch((reason) => setError(String(reason)));
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [monitorIndex, sessionId]);

  useEffect(() => {
    if (!textEditor) return;
    const frame = requestAnimationFrame(() => textEditorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [textEditor?.point.x, textEditor?.point.y]);

  useEffect(() => {
    const updateViewport = () => setViewport({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !imageReady) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    if (selection) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(selection.x, selection.y, selection.width, selection.height);
      ctx.clip();
      annotations.forEach((annotation, index) => {
        if (index !== textEditor?.annotationIndex) drawAnnotation(ctx, annotation, image, viewport.width, viewport.height);
      });
      if (draft) drawAnnotation(ctx, draft, image, viewport.width, viewport.height);
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = "rgba(4, 8, 14, 0.52)";
    ctx.beginPath();
    ctx.rect(0, 0, viewport.width, viewport.height);
    if (selection) ctx.rect(selection.x, selection.y, selection.width, selection.height);
    ctx.fill("evenodd");
    ctx.restore();

    if (selection) {
      ctx.save();
      ctx.strokeStyle = "#20d294";
      ctx.lineWidth = 2;
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
      const handles = [
        [selection.x, selection.y],
        [selection.x + selection.width / 2, selection.y],
        [selection.x + selection.width, selection.y],
        [selection.x + selection.width, selection.y + selection.height / 2],
        [selection.x + selection.width, selection.y + selection.height],
        [selection.x + selection.width / 2, selection.y + selection.height],
        [selection.x, selection.y + selection.height],
        [selection.x, selection.y + selection.height / 2]
      ];
      ctx.fillStyle = "#20d294";
      handles.forEach(([x, y]) => ctx.fillRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE));
      ctx.restore();
    }

    if (selectedTextIndex !== null) {
      const annotation = annotations[selectedTextIndex];
      if (annotation?.type === "text") {
        const bounds = getTextBounds(ctx, annotation);
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
        ctx.restore();
      }
    }
  }, [annotations, draft, imageReady, selectedTextIndex, selection, textEditor?.annotationIndex, viewport]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  const eventPoint = (event: React.PointerEvent<HTMLElement>): Point => ({
    x: event.clientX,
    y: event.clientY
  });

  const sampleColor = (point: Point) => {
    const source = colorCanvasRef.current;
    if (!source || point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) return;
    const x = clamp(Math.floor(point.x * source.width / viewport.width), 0, source.width - 1);
    const y = clamp(Math.floor(point.y * source.height / viewport.height), 0, source.height - 1);
    const pixel = source.getContext("2d", { willReadFrequently: true })?.getImageData(x, y, 1, 1).data;
    if (pixel) setHoverColor(`#${Array.from(pixel.slice(0, 3), (channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
  };

  const startDrawing = (point: Point) => {
    dragRef.current = { mode: "draw", start: point };
    if (tool === "pen") {
      setDraft({ type: "pen", points: [point], color, width: strokeWidth });
    } else if (tool !== "select" && tool !== "text") {
      setDraft({ type: tool, start: point, end: point, color, width: strokeWidth });
    }
  };

  const startRegionDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (busy || !selection || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode: "move-region", start: eventPoint(event), original: selection, offset: { x: 0, y: 0 } };
    setSizeDraft(null);
    setHoverHandle(null);
    setHoverTextIndex(null);
    setRegionDragging(true);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    setSizeDraft(null);
    const point = eventPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);

    const handle = selection ? getResizeHandle(point, selection) : null;
    if (selection && handle) {
      setSelectedTextIndex(null);
      dragRef.current = { mode: "resize", start: point, original: selection, handle };
      return;
    }
    if (selection && pointInRect(point, selection) && !handle && (tool === "select" || tool === "text")) {
      const ctx = canvasRef.current?.getContext("2d");
      const annotationIndex = ctx ? findTextAnnotationIndex(ctx, annotations, point) : -1;
      if (annotationIndex >= 0) {
        const annotation = annotations[annotationIndex] as TextAnnotation;
        setTool("text");
        setSelectedTextIndex(annotationIndex);
        setHoverTextIndex(annotationIndex);
        setColor(annotation.color);
        setFontSize(annotation.fontSize);
        setTextBackgroundEnabled(Boolean(annotation.backgroundColor));
        if (annotation.backgroundColor) setTextBackgroundColor(annotation.backgroundColor);
        setRedoStack([]);
        dragRef.current = { mode: "move-text", start: point, original: annotation.point, annotationIndex };
        return;
      }
    }

    if (!selection || (tool === "select" && !pointInRect(point, selection) && !handle)) {
      dragRef.current = { mode: "new", start: point };
      setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
      setAnnotations([]);
      setRedoStack([]);
      setSelectedTextIndex(null);
      setHoverTextIndex(null);
      setTextEditor(null);
      return;
    }

    if (tool === "select") {
      setSelectedTextIndex(null);
      dragRef.current = handle
        ? { mode: "resize", start: point, original: selection, handle }
        : { mode: "move", start: point, original: selection };
      return;
    }

    if (!pointInRect(point, selection)) return;
    if (tool === "text") {
      setSelectedTextIndex(null);
      dragRef.current = { mode: "text", point };
      return;
    }
    startDrawing(point);
  };

  const resizeSelection = (drag: Extract<DragState, { mode: "resize" }>, point: Point) => {
    let left = drag.original.x;
    let top = drag.original.y;
    let right = drag.original.x + drag.original.width;
    let bottom = drag.original.y + drag.original.height;
    if (drag.handle.includes("w")) left = point.x;
    if (drag.handle.includes("e")) right = point.x;
    if (drag.handle.includes("n")) top = point.y;
    if (drag.handle.includes("s")) bottom = point.y;
    return rectFromPoints(
      { x: clamp(left, 0, viewport.width), y: clamp(top, 0, viewport.height) },
      { x: clamp(right, 0, viewport.width), y: clamp(bottom, 0, viewport.height) }
    );
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const point = eventPoint(event);
    sampleColor(point);
    if (!drag) {
      const handle = selection ? getResizeHandle(point, selection) : null;
      setHoverHandle((current) => current === handle ? current : handle);
      const ctx = canvasRef.current?.getContext("2d");
      const hit = selection && pointInRect(point, selection) && !handle && (tool === "select" || tool === "text") && ctx
        ? findTextAnnotationIndex(ctx, annotations, point)
        : -1;
      const nextHover = hit >= 0 ? hit : null;
      setHoverTextIndex((current) => current === nextHover ? current : nextHover);
      return;
    }
    if (drag.mode === "new") {
      setSelection(rectFromPoints(drag.start, {
        x: clamp(point.x, 0, viewport.width),
        y: clamp(point.y, 0, viewport.height)
      }));
    } else if (drag.mode === "move" || drag.mode === "move-region") {
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      const next = {
        ...drag.original,
        x: clamp(drag.original.x + dx, 0, viewport.width - drag.original.width),
        y: clamp(drag.original.y + dy, 0, viewport.height - drag.original.height)
      };
      setSelection(next);
      if (drag.mode === "move-region") {
        const offset = { x: next.x - drag.original.x, y: next.y - drag.original.y };
        const delta = { x: offset.x - drag.offset.x, y: offset.y - drag.offset.y };
        drag.offset = offset;
        setAnnotations((current) => current.map((annotation) => translateAnnotation(annotation, delta)));
        setRedoStack((current) => current.map((annotation) => translateAnnotation(annotation, delta)));
        setTextEditor((current) => current ? { ...current, point: { x: current.point.x + delta.x, y: current.point.y + delta.y } } : null);
      }
    } else if (drag.mode === "resize") {
      setSelection(resizeSelection(drag, point));
    } else if (drag.mode === "move-text" && selection) {
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      const ctx = canvasRef.current?.getContext("2d");
      const annotation = annotations[drag.annotationIndex];
      const bounds = ctx && annotation?.type === "text" ? getTextBounds(ctx, annotation) : null;
      const padding = annotation?.type === "text" ? annotation.point.x - (bounds?.x ?? annotation.point.x) : 0;
      const maxX = bounds ? selection.x + selection.width - bounds.width + padding : selection.x + selection.width;
      const maxY = bounds ? selection.y + selection.height - bounds.height + padding : selection.y + selection.height;
      const nextPoint = {
        x: clamp(drag.original.x + dx, selection.x + padding, Math.max(selection.x + padding, maxX)),
        y: clamp(drag.original.y + dy, selection.y + padding, Math.max(selection.y + padding, maxY))
      };
      setAnnotations((current) => current.map((annotation, index) =>
        index === drag.annotationIndex && annotation.type === "text"
          ? { ...annotation, point: nextPoint }
          : annotation
      ));
    } else if (drag.mode === "draw") {
      setDraft((current) => {
        if (current?.type === "pen") {
          return { ...current, points: [...current.points, point] };
        }
        if (current && "end" in current) {
          return { ...current, end: point };
        }
        return current;
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const drag = dragRef.current;
    dragRef.current = null;
    setRegionDragging(false);
    const point = eventPoint(event);
    setHoverHandle(selection ? getResizeHandle(point, selection) : null);
    if (drag?.mode === "text") {
      setTextEditor({ point: drag.point, value: "", annotationIndex: null });
    } else if (drag?.mode === "new") {
      setSelection((current) => current && current.width >= MIN_SELECTION && current.height >= MIN_SELECTION ? current : null);
    } else if (drag?.mode === "draw") {
      setDraft((current) => {
        if (!current) return null;
        const valid = current.type === "pen"
          ? current.points.length > 1
          : "end" in current && Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y) > 2;
        if (valid) {
          setAnnotations((annotations) => [...annotations, current]);
          setRedoStack([]);
        }
        return null;
      });
    }
  };

  const commitText = () => {
    if (!textEditor) return;
    const text = textEditor.value.trim();
    if (textEditor.annotationIndex !== null) {
      const index = textEditor.annotationIndex;
      setAnnotations((current) => text
        ? current.map((annotation, currentIndex) => currentIndex === index && annotation.type === "text"
          ? { ...annotation, text, color, fontSize, backgroundColor: textBackgroundEnabled ? textBackgroundColor : null }
          : annotation)
        : current.filter((_, currentIndex) => currentIndex !== index));
      setSelectedTextIndex(text ? index : null);
      setRedoStack([]);
    } else if (text) {
      setSelectedTextIndex(annotations.length);
      setAnnotations((current) => [...current, {
          type: "text",
          point: textEditor.point,
          text,
          color,
          width: strokeWidth,
          fontSize,
          backgroundColor: textBackgroundEnabled ? textBackgroundColor : null
        }]);
      setRedoStack([]);
    }
    setTextEditor(null);
  };

  const undo = useCallback(() => {
    setSelectedTextIndex(null);
    setAnnotations((current) => {
      const last = current[current.length - 1];
      if (!last) return current;
      setRedoStack((redo) => [...redo, last]);
      return current.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setSelectedTextIndex(null);
    setRedoStack((current) => {
      const last = current[current.length - 1];
      if (!last) return current;
      setAnnotations((items) => [...items, last]);
      return current.slice(0, -1);
    });
  }, []);

  const exportSelection = useCallback(() => {
    const image = imageRef.current;
    if (!image || !selection) throw new Error("请先框选截图区域");
    const scaleX = image.naturalWidth / viewport.width;
    const scaleY = image.naturalHeight / viewport.height;
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(selection.width * scaleX));
    output.height = Math.max(1, Math.round(selection.height * scaleY));
    const ctx = output.getContext("2d");
    if (!ctx) throw new Error("无法创建截图画布");
    ctx.drawImage(
      image,
      selection.x * scaleX,
      selection.y * scaleY,
      selection.width * scaleX,
      selection.height * scaleY,
      0,
      0,
      output.width,
      output.height
    );
    ctx.save();
    ctx.scale(scaleX, scaleY);
    ctx.translate(-selection.x, -selection.y);
    ctx.beginPath();
    ctx.rect(selection.x, selection.y, selection.width, selection.height);
    ctx.clip();
    const exportAnnotations = textEditor?.annotationIndex !== null && textEditor
      ? annotations.flatMap((annotation, index) => index === textEditor.annotationIndex
        ? (textEditor.value.trim() && annotation.type === "text" ? [{
          ...annotation,
          text: textEditor.value.trim(),
          color,
          fontSize,
          backgroundColor: textBackgroundEnabled ? textBackgroundColor : null
        }] : [])
        : [annotation])
      : textEditor?.value.trim()
      ? [...annotations, {
        type: "text" as const,
        point: textEditor.point,
        text: textEditor.value.trim(),
        color,
        width: strokeWidth,
        fontSize,
        backgroundColor: textBackgroundEnabled ? textBackgroundColor : null
      }]
      : annotations;
    exportAnnotations.forEach((annotation) => drawAnnotation(ctx, annotation, image, viewport.width, viewport.height));
    ctx.restore();
    return output.toDataURL("image/png");
  }, [annotations, color, fontSize, selection, strokeWidth, textBackgroundColor, textBackgroundEnabled, textEditor, viewport.height, viewport.width]);

  const finish = useCallback(async (copyToClipboard: boolean, savePath?: string) => {
    if (!selection || busy) return;
    setBusy(true);
    setError("");
    try {
      const dataUrl = exportSelection();
      await invoke("complete_screenshot", {
        sessionId,
        dataUrl,
        copyToClipboard,
        savePath: savePath ?? null
      });
    } catch (reason) {
      setBusy(false);
      setError(String(reason));
    }
  }, [busy, exportSelection, selection, sessionId]);

  const saveScreenshot = useCallback(async () => {
    const path = await save({
      defaultPath: `TieZ-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      filters: [{ name: "PNG Image", extensions: ["png"] }]
    });
    if (path) await finish(false, path);
  }, [finish]);

  const pinScreenshot = useCallback(async () => {
    if (!payload || !selection || busy) return;
    setBusy(true);
    setError("");
    try {
      const scaleX = payload.width / viewport.width;
      const scaleY = payload.height / viewport.height;
      await invoke("pin_screenshot", {
        sessionId,
        dataUrl: exportSelection(),
        x: Math.round(payload.x + selection.x * scaleX),
        y: Math.round(payload.y + selection.y * scaleY),
        width: Math.max(1, Math.round(selection.width * scaleX)),
        height: Math.max(1, Math.round(selection.height * scaleY))
      });
    } catch (reason) {
      setBusy(false);
      setError(String(reason));
    }
  }, [busy, exportSelection, payload, selection, sessionId, viewport.height, viewport.width]);

  const cancel = useCallback(() => {
    invoke("cancel_screenshot", { sessionId }).catch(console.error);
  }, [sessionId]);

  const copyHoverColor = useCallback(async () => {
    if (!hoverColor || busy) return;
    try {
      await invoke("copy_screenshot_color", { color: hoverColor });
    } catch (reason) {
      setError(String(reason));
    }
  }, [busy, hoverColor]);

  const activateTool = useCallback((nextTool: Tool) => {
    setTool(nextTool);
    if (nextTool !== "text") setHoverTextIndex(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      const key = event.key.toLowerCase();
      if ((event.code === "Space" || event.key === " ") && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) void copyHoverColor();
      } else if (event.key === "Escape") cancel();
      else if (event.key === "Enter") void finish(true);
      else if (event.ctrlKey && key === "c") void finish(true);
      else if (event.ctrlKey && key === "s") {
        event.preventDefault();
        void saveScreenshot();
      } else if (event.ctrlKey && event.shiftKey && key === "z") redo();
      else if (event.ctrlKey && key === "z") undo();
      else if (key === "s") activateTool("select");
      else if (key === "r") activateTool("rect");
      else if (key === "c") activateTool("ellipse");
      else if (key === "a") activateTool("arrow");
      else if (key === "p") activateTool("pen");
      else if (key === "m") activateTool("mosaic");
      else if (key === "t") activateTool("text");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activateTool, cancel, copyHoverColor, finish, redo, saveScreenshot, undo]);

  const sizeLabelTop = selection ? Math.max(4, selection.y - 36) : 0;
  const toolbarTop = selection
    ? (selection.y + selection.height + 58 <= viewport.height
      ? selection.y + selection.height + 10
      : selection.y >= 96
        ? selection.y - 92
        : Math.min(sizeLabelTop + 40, Math.max(8, viewport.height - 56)))
    : 0;
  const toolbarHalfWidth = Math.min(360, Math.max(0, viewport.width / 2 - 8));
  const toolbarLeft = selection
    ? clamp(selection.x + selection.width / 2, toolbarHalfWidth, viewport.width - toolbarHalfWidth)
    : 0;
  return (
    <div
      className={`screenshot-overlay ${busy ? "is-busy" : ""}`}
      onContextMenu={(event) => event.preventDefault()}
    >
      {payload && (
        <img
          ref={imageRef}
          className="screenshot-source"
          src={imageUrl}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            const source = document.createElement("canvas");
            source.width = image.naturalWidth;
            source.height = image.naturalHeight;
            source.getContext("2d", { willReadFrequently: true })?.drawImage(image, 0, 0);
            colorCanvasRef.current = source;
            setImageReady(true);
          }}
          onError={() => setError("截图画面加载失败")}
        />
      )}
      <canvas
        ref={canvasRef}
        className="screenshot-canvas"
        width={Math.round(viewport.width * viewport.dpr)}
        height={Math.round(viewport.height * viewport.dpr)}
        style={{ cursor: dragRef.current?.mode === "move-text" ? "grabbing" : hoverHandle ? resizeCursors[hoverHandle] : hoverTextIndex !== null ? "move" : tool === "text" ? "text" : tool === "select" && selection ? "default" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          setHoverTextIndex(null);
          setHoverHandle(null);
        }}
        onDoubleClick={(event) => {
          const ctx = canvasRef.current?.getContext("2d");
          const index = ctx ? findTextAnnotationIndex(ctx, annotations, { x: event.clientX, y: event.clientY }) : -1;
          const annotation = annotations[index];
          if (annotation?.type === "text") {
            setTool("text");
            setSelectedTextIndex(index);
            setTextEditor({ point: annotation.point, value: annotation.text, annotationIndex: index });
          } else if (selection && pointInRect({ x: event.clientX, y: event.clientY }, selection) && !getResizeHandle({ x: event.clientX, y: event.clientY }, selection) && !textEditor) {
            void finish(true);
          }
        }}
      />

      {selection && (
        <div
          className="screenshot-size-label"
          style={{
            left: clamp(selection.x, 4, Math.max(4, viewport.width - 340)),
            top: sizeLabelTop
          }}
        >
          <button
            type="button"
            className={`screenshot-region-grip ${regionDragging ? "is-dragging" : ""}`}
            title="拖动截图区域"
            aria-label="拖动截图区域"
            disabled={busy}
            onPointerDown={startRegionDrag}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onLostPointerCapture={() => {
              if (dragRef.current?.mode === "move-region") dragRef.current = null;
              setRegionDragging(false);
            }}
          >
            <GripVertical size={16} />
          </button>
          <div
            className="screenshot-size-inputs"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSizeDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (applySelectionSize()) (event.target as HTMLInputElement).blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSizeDraft(null);
                setError("");
                (event.target as HTMLInputElement).blur();
              }
            }}
          >
            <input
              className="screenshot-dimension"
              type="number"
              min="1"
              max={sourceWidth}
              step="1"
              aria-label="截图宽度"
              title="截图宽度（像素）"
              disabled={busy}
              value={sizeDraft?.width ?? selectionPixelWidth}
              onFocus={(event) => {
                setSizeDraft((current) => current ?? { width: String(selectionPixelWidth), height: String(selectionPixelHeight) });
                event.currentTarget.select();
              }}
              onChange={(event) => setSizeDraft((current) => ({ width: event.target.value, height: current?.height ?? String(selectionPixelHeight) }))}
            />
            <span>×</span>
            <input
              className="screenshot-dimension"
              type="number"
              min="1"
              max={sourceHeight}
              step="1"
              aria-label="截图高度"
              title="截图高度（像素）"
              disabled={busy}
              value={sizeDraft?.height ?? selectionPixelHeight}
              onFocus={(event) => {
                setSizeDraft((current) => current ?? { width: String(selectionPixelWidth), height: String(selectionPixelHeight) });
                event.currentTarget.select();
              }}
              onChange={(event) => setSizeDraft((current) => ({ width: current?.width ?? String(selectionPixelWidth), height: event.target.value }))}
            />
          </div>
          {hoverColor && (
            <span className="screenshot-hover-color">
              <span className="screenshot-hover-swatch" style={{ backgroundColor: hoverColor }} />
              <span data-test-hover-color>{hoverColor}</span>
              <span className="screenshot-color-copy-hint">空格键复制</span>
            </span>
          )}
        </div>
      )}

      {selection && selection.width > 0 && selection.height > 0 && (
        <div
          className="screenshot-toolbar"
          style={{ left: toolbarLeft, top: toolbarTop }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ToolbarButton title="选择 / 移动 (S)" active={tool === "select"} onClick={() => activateTool("select")}><MousePointer2 size={19} /></ToolbarButton>
          <ToolbarButton title="矩形 (R)" active={tool === "rect"} onClick={() => activateTool("rect")}><Square size={19} /></ToolbarButton>
          <ToolbarButton title="椭圆 (C)" active={tool === "ellipse"} onClick={() => activateTool("ellipse")}><Circle size={19} /></ToolbarButton>
          <ToolbarButton title="箭头 (A)" active={tool === "arrow"} onClick={() => activateTool("arrow")}><ArrowUpRight size={20} /></ToolbarButton>
          <ToolbarButton title="画笔 (P)" active={tool === "pen"} onClick={() => activateTool("pen")}><Pencil size={19} /></ToolbarButton>
          <ToolbarButton title="马赛克 (M)" active={tool === "mosaic"} onClick={() => activateTool("mosaic")}><Grid3X3 size={19} /></ToolbarButton>
          <ToolbarButton title="文字 (T)" active={tool === "text"} onClick={() => activateTool("text")}><Type size={19} /></ToolbarButton>
          <div className="screenshot-toolbar-separator" />
          <input
            className="screenshot-color"
            type="color"
            value={color}
            title={tool === "text" ? "文字颜色" : "颜色"}
            onChange={(event) => {
              setColor(event.target.value);
              updateSelectedText({ color: event.target.value });
            }}
          />
          {tool === "text" ? (
            <>
              <input
                className="screenshot-font-size"
                type="number"
                min="12"
                max="96"
                step="1"
                value={fontSize}
                title="文字大小"
                onChange={(event) => {
                  const nextSize = clamp(Number(event.target.value) || 12, 12, 96);
                  setFontSize(nextSize);
                  updateSelectedText({ fontSize: nextSize });
                }}
              />
              <ToolbarButton
                title="文字背景"
                active={textBackgroundEnabled}
                onClick={() => {
                  const enabled = !textBackgroundEnabled;
                  setTextBackgroundEnabled(enabled);
                  updateSelectedText({ backgroundColor: enabled ? textBackgroundColor : null });
                }}
              >
                <PaintBucket size={18} />
              </ToolbarButton>
              <input
                className="screenshot-color screenshot-background-color"
                type="color"
                value={textBackgroundColor}
                disabled={!textBackgroundEnabled}
                title="文字背景颜色"
                onChange={(event) => {
                  setTextBackgroundColor(event.target.value);
                  if (textBackgroundEnabled) updateSelectedText({ backgroundColor: event.target.value });
                }}
              />
            </>
          ) : (
            <input className="screenshot-width" type="range" min="1" max="12" value={strokeWidth} title="线条粗细" onChange={(event) => setStrokeWidth(Number(event.target.value))} />
          )}
          <div className="screenshot-toolbar-separator" />
          <ToolbarButton title="撤销 (Ctrl+Z)" disabled={annotations.length === 0} onClick={undo}><Undo2 size={19} /></ToolbarButton>
          <ToolbarButton title="重做 (Ctrl+Shift+Z)" disabled={redoStack.length === 0} onClick={redo}><Redo2 size={19} /></ToolbarButton>
          <ToolbarButton title="锁定到屏幕" disabled={busy} onClick={() => void pinScreenshot()}><Pin size={19} /></ToolbarButton>
          <ToolbarButton title="保存 (Ctrl+S)" disabled={busy} onClick={() => void saveScreenshot()}><Download size={19} /></ToolbarButton>
          <ToolbarButton title="取消 (Esc)" className="cancel" onClick={cancel}><X size={20} /></ToolbarButton>
          <ToolbarButton title="复制并完成 (Enter)" className="confirm" disabled={busy} onClick={() => void finish(true)}><Check size={21} /></ToolbarButton>
        </div>
      )}

      {textEditor && (
        <textarea
          ref={textEditorRef}
          className="screenshot-text-editor"
          style={{
            left: clamp(textEditor.point.x, 8, Math.max(8, viewport.width - 248)),
            top: clamp(textEditor.point.y, 8, Math.max(8, viewport.height - 90)),
            fontSize,
            backgroundColor: textBackgroundEnabled ? textBackgroundColor : "rgba(255, 255, 255, 0.96)",
            color
          }}
          value={textEditor.value}
          placeholder="输入文字"
          onChange={(event) => setTextEditor({ ...textEditor, value: event.target.value })}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setTextEditor(null);
            }
            if (event.key === "Enter" && event.ctrlKey) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      )}

      {error && <div className="screenshot-error">{error}</div>}
    </div>
  );
};

export default ScreenshotOverlayWindow;
