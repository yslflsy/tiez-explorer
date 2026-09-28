use crate::error::{AppError, AppResult};
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug)]
pub struct ScreenshotMonitor {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
    pub path: PathBuf,
    pub window_label: String,
}

#[derive(Debug)]
pub struct ScreenshotSession {
    pub id: String,
    pub monitors: Vec<ScreenshotMonitor>,
}

#[derive(Default)]
pub struct ScreenshotState(pub Mutex<Option<ScreenshotSession>>);

#[derive(Default)]
pub struct PinnedScreenshotState(pub Mutex<HashMap<String, PathBuf>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotMonitorPayload {
    pub session_id: String,
    pub monitor_index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotCompleteResult {
    pub saved_path: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct PinWindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn pin_window_bounds(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> PinWindowBounds {
    // Match the 10px inset of .screenshot-pin-root at the window's DPI scale.
    let margin = (10.0 * scale_factor).round() as u32;
    PinWindowBounds {
        x: x.saturating_sub(margin as i32),
        y: y.saturating_sub(margin as i32),
        width: width + 2 * margin,
        height: height + 2 * margin,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn close_existing_session(app: &AppHandle, expected_id: Option<&str>) {
    let Some(state) = app.try_state::<ScreenshotState>() else {
        return;
    };

    let session = {
        let mut guard = state.0.lock().unwrap();
        if let (Some(expected), Some(active)) = (expected_id, guard.as_ref()) {
            if active.id != expected {
                return;
            }
        }
        guard.take()
    };

    if let Some(session) = session {
        crate::info!(
            ">>> [SCREENSHOT] Closing screenshot session {} (requested {:?})",
            session.id,
            expected_id
        );
        for monitor in session.monitors {
            if let Some(window) = app.get_webview_window(&monitor.window_label) {
                let _ = window.close();
            }
            let _ = std::fs::remove_file(monitor.path);
        }
    }
}

#[cfg(target_os = "windows")]
fn capture_monitors(session_id: &str) -> AppResult<Vec<ScreenshotMonitor>> {
    let mut monitors =
        xcap::Monitor::all().map_err(|e| AppError::Internal(format!("无法枚举显示器: {e}")))?;
    monitors.sort_by_key(|monitor| !monitor.is_primary().unwrap_or(false));

    struct MonitorCapture {
        name: String,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        image: image::RgbaImage,
    }

    let mut captures = Vec::with_capacity(monitors.len());
    for (index, monitor) in monitors.into_iter().enumerate() {
        let name = monitor
            .friendly_name()
            .or_else(|_| monitor.name())
            .unwrap_or_else(|_| format!("Display {}", index + 1));
        let x = monitor
            .x()
            .map_err(|e| AppError::Internal(format!("读取显示器坐标失败: {e}")))?;
        let y = monitor
            .y()
            .map_err(|e| AppError::Internal(format!("读取显示器坐标失败: {e}")))?;
        let reported_width = monitor
            .width()
            .map_err(|e| AppError::Internal(format!("读取显示器宽度失败: {e}")))?;
        let reported_height = monitor
            .height()
            .map_err(|e| AppError::Internal(format!("读取显示器高度失败: {e}")))?;
        let image = monitor
            .capture_image()
            .map_err(|e| AppError::Internal(format!("捕获显示器画面失败: {e}")))?;
        let (width, height) = image.dimensions();
        if width != reported_width || height != reported_height {
            crate::info!(
                ">>> [SCREENSHOT] Display size normalized from {}x{} to captured {}x{}",
                reported_width,
                reported_height,
                width,
                height
            );
        }

        captures.push(MonitorCapture {
            name,
            x,
            y,
            width,
            height,
            image,
        });
    }

    if captures.is_empty() {
        return Err(AppError::Internal("没有检测到可用显示器".to_string()));
    }

    let min_x = captures.iter().map(|monitor| monitor.x).min().unwrap_or(0);
    let min_y = captures.iter().map(|monitor| monitor.y).min().unwrap_or(0);
    let max_x = captures
        .iter()
        .map(|monitor| monitor.x as i64 + monitor.width as i64)
        .max()
        .unwrap_or(0);
    let max_y = captures
        .iter()
        .map(|monitor| monitor.y as i64 + monitor.height as i64)
        .max()
        .unwrap_or(0);
    let virtual_width = (max_x - min_x as i64).max(1) as u32;
    let virtual_height = (max_y - min_y as i64).max(1) as u32;
    if virtual_width > 32_768
        || virtual_height > 32_768
        || (virtual_width as u64 * virtual_height as u64) > 500_000_000
    {
        return Err(AppError::Validation(
            "虚拟桌面尺寸过大，无法创建跨屏截图画布".to_string(),
        ));
    }

    let names = captures
        .iter()
        .map(|monitor| monitor.name.as_str())
        .collect::<Vec<_>>()
        .join(" + ");
    let mut desktop = image::RgbaImage::from_pixel(
        virtual_width,
        virtual_height,
        image::Rgba([18, 18, 18, 255]),
    );
    for monitor in captures {
        image::imageops::overlay(
            &mut desktop,
            &monitor.image,
            (monitor.x - min_x) as i64,
            (monitor.y - min_y) as i64,
        );
    }

    let path = std::env::temp_dir().join(format!("TieZ_Screenshot_{}.png", session_id));
    desktop
        .save(&path)
        .map_err(|e| AppError::IO(format!("保存临时截图失败: {e}")))?;

    Ok(vec![ScreenshotMonitor {
        index: 0,
        name: names,
        x: min_x,
        y: min_y,
        width: virtual_width,
        height: virtual_height,
        scale_factor: 1.0,
        is_primary: true,
        path,
        window_label: format!("screenshot-{}", session_id),
    }])
}

#[cfg(not(target_os = "windows"))]
fn capture_monitors(_session_id: &str) -> AppResult<Vec<ScreenshotMonitor>> {
    Err(AppError::Validation(
        "第一期截图功能目前仅支持 Windows".to_string(),
    ))
}

fn create_overlay_windows(app: &AppHandle, session: &ScreenshotSession) -> AppResult<()> {
    for monitor in &session.monitors {
        let url = format!(
            "index.html?window=screenshot-overlay&session={}&monitor={}",
            session.id, monitor.index
        );
        let window =
            WebviewWindowBuilder::new(app, &monitor.window_label, WebviewUrl::App(url.into()))
                .title("TieZ Screenshot")
                .visible(false)
                .decorations(false)
                .transparent(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .inner_size(monitor.width as f64, monitor.height as f64)
                .position(monitor.x as f64, monitor.y as f64)
                .focused(monitor.is_primary)
                .build()
                .map_err(AppError::from)?;

        window
            .set_position(PhysicalPosition::new(monitor.x, monitor.y))
            .map_err(AppError::from)?;
        window
            .set_size(PhysicalSize::new(monitor.width, monitor.height))
            .map_err(AppError::from)?;
        window.show().map_err(AppError::from)?;
        crate::info!(
            ">>> [SCREENSHOT] Overlay {} shown at ({}, {}) {}x{}",
            monitor.window_label,
            monitor.x,
            monitor.y,
            monitor.width,
            monitor.height
        );
        if monitor.is_primary {
            let _ = window.set_focus();
        }
    }
    Ok(())
}

pub async fn begin_screenshot(app: AppHandle) -> AppResult<String> {
    crate::info!(">>> [SCREENSHOT] Starting screenshot session");
    close_existing_session(&app, None);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window("compact-preview") {
        let _ = window.hide();
    }

    tokio::time::sleep(std::time::Duration::from_millis(140)).await;

    let session_id = uuid::Uuid::new_v4().simple().to_string();
    let capture_id = session_id.clone();
    let capture_result =
        tauri::async_runtime::spawn_blocking(move || capture_monitors(&capture_id))
            .await
            .map_err(|e| AppError::Internal(format!("截图任务失败: {e}")))
            .and_then(|result| result);
    let monitors = match capture_result {
        Ok(monitors) => monitors,
        Err(error) => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            return Err(error);
        }
    };
    crate::info!(
        ">>> [SCREENSHOT] Captured virtual desktop with {} overlay target(s)",
        monitors.len()
    );

    let session = ScreenshotSession {
        id: session_id.clone(),
        monitors,
    };

    if let Err(error) = create_overlay_windows(&app, &session) {
        for monitor in session.monitors {
            let _ = std::fs::remove_file(monitor.path);
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return Err(error);
    }

    let state = app.state::<ScreenshotState>();
    *state.0.lock().unwrap() = Some(session);
    Ok(session_id)
}

#[tauri::command]
pub async fn start_screenshot(app: AppHandle) -> AppResult<String> {
    begin_screenshot(app).await
}

#[tauri::command]
pub fn get_screenshot_monitor(
    app: AppHandle,
    session_id: String,
    monitor_index: usize,
) -> AppResult<ScreenshotMonitorPayload> {
    let state = app.state::<ScreenshotState>();
    let guard = state.0.lock().unwrap();
    let session = guard
        .as_ref()
        .filter(|session| session.id == session_id)
        .ok_or_else(|| AppError::Validation("截图会话已结束".to_string()))?;
    let monitor = session
        .monitors
        .iter()
        .find(|monitor| monitor.index == monitor_index)
        .ok_or_else(|| AppError::Validation("未找到目标显示器".to_string()))?;

    Ok(ScreenshotMonitorPayload {
        session_id: session.id.clone(),
        monitor_index: monitor.index,
        name: monitor.name.clone(),
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
        scale_factor: monitor.scale_factor,
        is_primary: monitor.is_primary,
    })
}

#[tauri::command]
pub fn get_screenshot_image(
    app: AppHandle,
    session_id: String,
    monitor_index: usize,
) -> AppResult<tauri::ipc::Response> {
    let path = {
        let state = app.state::<ScreenshotState>();
        let guard = state.0.lock().unwrap();
        let session = guard
            .as_ref()
            .filter(|session| session.id == session_id)
            .ok_or_else(|| AppError::Validation("截图会话已结束".to_string()))?;
        session
            .monitors
            .iter()
            .find(|monitor| monitor.index == monitor_index)
            .map(|monitor| monitor.path.clone())
            .ok_or_else(|| AppError::Validation("未找到目标显示器".to_string()))?
    };

    let bytes = std::fs::read(path)
        .map_err(|error| AppError::IO(format!("无法读取截图源文件: {error}")))?;
    if bytes.len() > 200 * 1024 * 1024 {
        return Err(AppError::Validation("截图源文件过大".to_string()));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn get_pinned_screenshot(app: AppHandle, pin_id: String) -> AppResult<tauri::ipc::Response> {
    let path = {
        let state = app.state::<PinnedScreenshotState>();
        let path = state
            .0
            .lock()
            .unwrap()
            .get(&pin_id)
            .cloned()
            .ok_or_else(|| AppError::Validation("贴图已关闭".to_string()))?;
        path
    };
    let bytes =
        std::fs::read(path).map_err(|error| AppError::IO(format!("无法读取贴图文件: {error}")))?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn decode_png_data_url(data_url: &str) -> AppResult<Vec<u8>> {
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| AppError::Validation("截图数据格式无效".to_string()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| AppError::Validation(format!("截图数据解码失败: {e}")))?;
    if bytes.len() > 100 * 1024 * 1024 {
        return Err(AppError::Validation("截图数据过大".to_string()));
    }
    image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| AppError::Validation(format!("截图 PNG 无效: {e}")))?;
    Ok(bytes)
}

#[tauri::command]
pub async fn pin_screenshot(
    app: AppHandle,
    session_id: String,
    data_url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> AppResult<String> {
    {
        let state = app.state::<ScreenshotState>();
        let guard = state.0.lock().unwrap();
        if guard.as_ref().map(|session| session.id.as_str()) != Some(session_id.as_str()) {
            return Err(AppError::Validation("截图会话已结束".to_string()));
        }
    }
    if width < 4 || height < 4 || width > 32768 || height > 32768 {
        return Err(AppError::Validation("贴图尺寸无效".to_string()));
    }

    let bytes = decode_png_data_url(&data_url)?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| AppError::Validation(format!("贴图 PNG 无效: {e}")))?;
    if image.width() != width || image.height() != height {
        return Err(AppError::Validation(format!(
            "贴图尺寸与框选区域不一致: {}x{} != {}x{}",
            image.width(),
            image.height(),
            width,
            height
        )));
    }
    let scale_factor = app
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let origin = monitor.position();
                let size = monitor.size();
                x >= origin.x
                    && y >= origin.y
                    && (x as i64) < origin.x as i64 + size.width as i64
                    && (y as i64) < origin.y as i64 + size.height as i64
            })
        })
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let bounds = pin_window_bounds(x, y, width, height, scale_factor);
    let pin_id = uuid::Uuid::new_v4().simple().to_string();
    let path = std::env::temp_dir().join(format!("TieZ_Pin_{pin_id}.png"));
    std::fs::write(&path, bytes)?;
    app.state::<PinnedScreenshotState>()
        .0
        .lock()
        .unwrap()
        .insert(pin_id.clone(), path.clone());

    let label = format!("screenshot-pin-{pin_id}");
    let url = format!("index.html?window=screenshot-pin&pin={pin_id}");
    let window_result = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("TieZ Pinned Screenshot")
        .visible(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .inner_size(bounds.width as f64 / scale_factor, bounds.height as f64 / scale_factor)
        .position(bounds.x as f64 / scale_factor, bounds.y as f64 / scale_factor)
        .focused(true)
        .build();
    let window = match window_result {
        Ok(window) => window,
        Err(error) => {
            app.state::<PinnedScreenshotState>()
                .0
                .lock()
                .unwrap()
                .remove(&pin_id);
            let _ = std::fs::remove_file(path);
            return Err(AppError::from(error));
        }
    };

    let cleanup_app = app.clone();
    let cleanup_id = pin_id.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let path = cleanup_app
                .state::<PinnedScreenshotState>()
                .0
                .lock()
                .unwrap()
                .remove(&cleanup_id);
            if let Some(path) = path {
                let _ = std::fs::remove_file(path);
            }
        }
    });
    crate::info!(
        ">>> [SCREENSHOT] Pin {} created for ({}, {}) {}x{} at scale {}",
        label,
        x,
        y,
        width,
        height,
        scale_factor
    );
    window.show().map_err(AppError::from)?;
    crate::info!(">>> [SCREENSHOT] Pin {} shown", label);
    window
        .set_size(PhysicalSize::new(bounds.width, bounds.height))
        .map_err(AppError::from)?;
    window
        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(AppError::from)?;
    crate::info!(">>> [SCREENSHOT] Pin {} positioned", label);
    let _ = window.set_focus();

    let cleanup_app = app.clone();
    let cleanup_session = session_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        close_existing_session(&cleanup_app, Some(&cleanup_session));
    });

    Ok(pin_id)
}

#[cfg(test)]
mod pin_window_tests {
    use super::{pin_window_bounds, PinWindowBounds};

    #[test]
    fn keeps_capture_at_original_physical_coordinates_across_dpi_scales() {
        assert_eq!(
            pin_window_bounds(100, 200, 420, 300, 1.0),
            PinWindowBounds { x: 90, y: 190, width: 440, height: 320 }
        );
        assert_eq!(
            pin_window_bounds(-800, 50, 420, 300, 1.25),
            PinWindowBounds { x: -813, y: 37, width: 446, height: 326 }
        );
    }
}

#[tauri::command]
pub async fn close_pinned_screenshot(app: AppHandle, pin_id: String) -> AppResult<()> {
    let label = format!("screenshot-pin-{pin_id}");
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| AppError::Validation("贴图已关闭".to_string()))?;
    window.close().map_err(AppError::from)
}

#[tauri::command]
pub async fn complete_screenshot(
    app: AppHandle,
    session_id: String,
    data_url: String,
    copy_to_clipboard: bool,
    save_path: Option<String>,
) -> AppResult<ScreenshotCompleteResult> {
    {
        let state = app.state::<ScreenshotState>();
        let guard = state.0.lock().unwrap();
        if guard.as_ref().map(|session| session.id.as_str()) != Some(session_id.as_str()) {
            return Err(AppError::Validation("截图会话已结束".to_string()));
        }
    }

    let bytes = decode_png_data_url(&data_url)?;
    let saved_path = if let Some(path) = save_path.filter(|path| !path.trim().is_empty()) {
        let path = if PathBuf::from(&path).extension().is_none() {
            format!("{path}.png")
        } else {
            path
        };
        std::fs::write(&path, &bytes)?;
        Some(path)
    } else {
        None
    };

    if copy_to_clipboard {
        let (primary_hash, secondary_hash, visual_hash) =
            crate::services::clipboard_ops::copy_image_bytes_to_clipboard(bytes.clone(), now_ms())?;
        crate::LAST_APP_SET_HASH.store(primary_hash, std::sync::atomic::Ordering::SeqCst);
        crate::LAST_APP_SET_HASH_ALT.store(secondary_hash, std::sync::atomic::Ordering::SeqCst);
        crate::LAST_APP_SET_IMAGE_VISUAL_HASH
            .store(visual_hash, std::sync::atomic::Ordering::SeqCst);
    }

    crate::services::clipboard::process_new_entry(
        &app,
        crate::services::clipboard::ClipboardData::Image { data_url },
        Some("TieZ Screenshot".to_string()),
        None,
    );

    let cleanup_app = app.clone();
    let cleanup_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        close_existing_session(&cleanup_app, Some(&cleanup_id));
    });

    Ok(ScreenshotCompleteResult { saved_path })
}

#[tauri::command]
pub fn copy_screenshot_color(color: String) -> AppResult<()> {
    if color.len() != 7 || !color.starts_with('#') || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::Validation("无效的颜色值".to_string()));
    }
    arboard::Clipboard::new()?.set_text(color)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_screenshot(app: AppHandle, session_id: String) {
    crate::info!(">>> [SCREENSHOT] Cancel requested for session {session_id}");
    close_existing_session(&app, Some(&session_id));
}
