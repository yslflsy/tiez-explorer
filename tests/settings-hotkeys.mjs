import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 740 } });
page.setDefaultTimeout(6000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.addInitScript(() => {
  window.__settingsCalls = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, windows: [{ label: "main" }] },
    transformCallback: () => 1,
    invoke: async (command, args) => {
      window.__settingsCalls.push({ command, args });
      if (command === "get_settings") {
        return {
          "app.hotkey": "Alt+C",
          "app.screenshot_hotkey": "Alt+A",
          "app.surface_opacity": localStorage.getItem("test_surface_opacity") ?? "100"
        };
      }
      if (command === "get_clipboard_history" || command === "get_all_windows") return [];
      if (command === "test_hotkey_available") return true;
      return null;
    }
  };
});

try {
  await page.goto("http://127.0.0.1:1420/");
  await page.getByTitle("设置").click();
  await page.getByText("剪贴板设置", { exact: true }).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--surface-opacity-scale") === "2");
  const initialBackground = await page.locator("#root").evaluate((element) => getComputedStyle(element).backgroundColor);
  assert(!initialBackground.startsWith("rgba(") || initialBackground.endsWith(", 1)"), `Initial background is translucent: ${initialBackground}`);
  const main = page.getByText("弹出主界面快捷键", { exact: true }).locator("..", { hasText: "弹出主界面快捷键" }).locator("..", { hasText: "弹出主界面快捷键" }).locator(".key-group");
  const screenshot = page.getByText("截图快捷键", { exact: true }).locator("..", { hasText: "截图快捷键" }).locator("..", { hasText: "截图快捷键" }).locator(".key-group");
  await main.waitFor();
  await screenshot.waitFor();
  assert((await main.textContent()).includes("C"));
  assert((await screenshot.textContent()).includes("A"));
  await page.setViewportSize({ width: 352, height: 380 });
  for (const control of [main, screenshot]) {
    const { labelRight, keyLeft } = await control.locator("xpath=..").evaluate((row) => ({
      labelRight: row.querySelector(".item-label-group").getBoundingClientRect().right,
      keyLeft: row.querySelector(".key-group").getBoundingClientRect().left
    }));
    assert(labelRight <= keyLeft, "Shortcut label overlaps its key control");
  }
  await screenshot.click();
  await page.keyboard.press("Control+Shift+S");
  await page.waitForFunction(() => window.__settingsCalls.some((call) => call.command === "set_screenshot_hotkey"));
  const saved = await page.evaluate(() => window.__settingsCalls.find((call) => call.command === "set_screenshot_hotkey"));
  assert.equal(saved.args.hotkey, "Ctrl+Shift+S");
  await main.click();
  await page.keyboard.press("Alt+M");
  await page.waitForFunction(() => window.__settingsCalls.some((call) => call.command === "register_hotkey" && call.args.hotkey === "Alt+M"));
  const beforeConflict = await page.evaluate(() => window.__settingsCalls.filter((call) => call.command === "set_screenshot_hotkey").length);
  await screenshot.click();
  await page.keyboard.press("Alt+M");
  await page.waitForTimeout(150);
  const afterConflict = await page.evaluate(() => window.__settingsCalls.filter((call) => call.command === "set_screenshot_hotkey").length);
  assert.equal(afterConflict, beforeConflict, "Conflicting shortcut should not replace screenshot shortcut");
  assert(pageErrors.length === 0, pageErrors.join("\n"));
  await page.evaluate(() => localStorage.setItem("test_surface_opacity", "50"));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--surface-opacity-scale") === "1");
  const savedBackground = await page.locator("#root").evaluate((element) => getComputedStyle(element).backgroundColor);
  assert(savedBackground.startsWith("rgba(") && !savedBackground.endsWith(", 1)"), `Saved translucency was not restored: ${savedBackground}`);
  console.log("Main/screenshot hotkeys, conflict handling and opaque default: PASS");
} catch (error) {
  console.error("Page errors:", pageErrors);
  console.error("Page text:", (await page.locator("body").innerText()).slice(0, 700));
  throw error;
} finally {
  await browser.close();
}
