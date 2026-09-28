import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 372, height: 400 } });
page.setDefaultTimeout(8000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.addInitScript(() => {
  const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='40'%3E%3Crect width='80' height='40' fill='%232f6fed'/%3E%3C/svg%3E";
  const longText = "A very long clipboard value that must remain complete in the hover preview despite being clipped in the table row. " + "More details. ".repeat(200) + "END OF FULL CONTENT";
  window.__calls = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, windows: [{ label: "main" }] },
    transformCallback: () => 1,
    invoke: async (command, args) => {
      window.__calls.push({ command, args });
      if (command === "get_settings") return {
        "app.hotkey": "Alt+C",
        "app.theme": "mica",
        "app.color_mode": localStorage.getItem("test_color_mode") ?? "light",
        "app.simplified_mode": localStorage.getItem("test_simplified_mode") ?? "false"
      };
      if (command === "get_clipboard_history") return [
        { id: 1, content_type: "text", content: "Pinned text", source_app: "Test", timestamp: Date.now(), preview: "Pinned text", is_pinned: true, tags: [] },
        { id: 2, content_type: "text", content: longText, source_app: "Test", timestamp: Date.now() - 2000, preview: "long", is_pinned: false, tags: [] },
        { id: 3, content_type: "image", content: image, source_app: "Test", timestamp: Date.now() - 3000, preview: "Image", is_pinned: false, tags: [] },
        { id: 4, content_type: "text", content: "MySecretPassword123", source_app: "Test", timestamp: Date.now() - 4000, preview: "Secret", is_pinned: false, tags: ["sensitive"] }
      ];
      if (command === "get_file_server_status") return { enabled: false, port: 0, ip: "" };
      if (command === "get_all_windows" || command === "scan_installed_apps" || command === "get_available_ips") return [];
      if (command === "save_setting" && args.key === "app.simplified_mode") localStorage.setItem("test_simplified_mode", args.value);
      return null;
    }
  };
});

try {
  await page.goto("http://127.0.0.1:1420/");
  await page.locator("[data-test-clipboard-item]").first().waitFor();
  assert.equal(await page.locator(".simplified-table-header").count(), 0);
  await page.getByTitle("精简模式").click();
  await page.locator(".simplified-table-header").waitFor();
  const shell = await page.locator("#root").evaluate((root) => ({
    rect: root.getBoundingClientRect().toJSON(),
    shadow: getComputedStyle(root).boxShadow,
    borderWidth: getComputedStyle(root).borderTopWidth
  }));
  assert.equal(shell.rect.x, 10);
  assert.equal(shell.rect.y, 10);
  assert.equal(shell.rect.width, 352);
  assert.notEqual(shell.shadow, "none");
  assert(shell.shadow.includes("rgba(0, 0, 0, 0.2)"));
  assert.equal(shell.borderWidth, "1px");
  assert.equal(await page.locator(".simplified-table-header").innerText(), "时间\n内容");
  assert.equal(await page.locator(".simplified-item").count(), 4);
  await page.waitForTimeout(500);
  const geometry = await page.locator(".simplified-item").first().evaluate((row) => {
    const time = row.querySelector("time").getBoundingClientRect();
    const content = row.querySelector(".simplified-content").getBoundingClientRect();
    return { height: row.getBoundingClientRect().height, timeRight: time.right, contentLeft: content.left };
  });
  assert(geometry.height <= 24, `Row is too tall: ${geometry.height}`);
  assert.equal(geometry.timeRight, geometry.contentLeft);
  if (process.env.VISUAL_QA) await page.screenshot({ path: "src-tauri/target/release/qa-simplified-table.png" });
  assert(await page.locator(".simplified-item").nth(1).locator(".simplified-content").evaluate((el) => el.scrollWidth > el.clientWidth));
  await page.locator(".simplified-item").nth(1).hover();
  await page.locator("[data-test-full-preview]").waitFor();
  const lightBackground = await page.locator("[data-test-full-preview]").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(lightBackground, "rgb(255, 255, 255)", `Light preview is translucent: ${lightBackground}`);
  assert((await page.locator("[data-test-full-preview]").innerText()).includes("despite being clipped in the table row"));
  assert((await page.locator("[data-test-full-preview]").innerText()).includes("END OF FULL CONTENT"));
  assert(await page.locator("[data-test-full-preview]").evaluate((el) => el.scrollHeight > el.clientHeight));
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector("[data-test-full-preview]")?.scrollTop > 0);
  await page.locator(".simplified-item").nth(2).hover();
  const previewImage = page.locator("[data-test-full-preview] img");
  await previewImage.waitFor();
  assert(await previewImage.evaluate((img) => img.complete && img.naturalWidth === 80));
  if (process.env.VISUAL_QA) await page.screenshot({ path: "src-tauri/target/release/qa-simplified-image-hover.png" });
  await page.locator(".simplified-item").nth(3).hover();
  const sensitiveText = await page.locator("[data-test-full-preview]").innerText();
  assert(!sensitiveText.includes("MySecretPassword123"), "Sensitive content was exposed in the preview");
  assert.equal(await page.evaluate(() => localStorage.getItem("test_simplified_mode")), "true");
  await page.reload();
  await page.locator(".simplified-table-header").waitFor();
  await page.evaluate(() => localStorage.setItem("test_color_mode", "dark"));
  await page.reload();
  await page.locator(".simplified-item").nth(1).hover();
  const darkBackground = await page.locator("[data-test-full-preview]").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(darkBackground, "rgb(37, 40, 46)", `Dark preview is translucent: ${darkBackground}`);
  if (process.env.VISUAL_QA) await page.screenshot({ path: "src-tauri/target/release/qa-simplified-dark-shadow.png" });
  await page.getByTitle("退出精简模式").click();
  await page.locator(".simplified-table-header").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => localStorage.getItem("test_simplified_mode")), "false");
  assert.deepEqual(pageErrors, []);
  console.log("Simplified table, full text/image hover, privacy and persistence: PASS");
} finally {
  await browser.close();
}
