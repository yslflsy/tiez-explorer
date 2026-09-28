import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });

await page.addInitScript(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 800;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const encoded = canvas.toDataURL("image/png").split(",")[1];
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  window.__screenshotCalls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.__screenshotCalls.push({ command, args });
      if (command === "get_screenshot_monitor") {
        return { sessionId: "test", monitorIndex: 0, name: "Test", x: 0, y: 0, width: 1200, height: 800, scaleFactor: 1, isPrimary: true };
      }
      if (command === "get_screenshot_image" || command === "get_pinned_screenshot") return bytes;
      return null;
    }
  };
});

try {
  await page.goto("http://127.0.0.1:1420/?window=screenshot-overlay&session=test&monitor=0");
  const canvas = page.locator(".screenshot-canvas");
  await canvas.waitFor();
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(520, 400, { steps: 8 });
  await page.mouse.up();
  await page.getByTitle("文字 (T)").click();
  await page.mouse.click(155, 165);
  await page.locator(".screenshot-text-editor").fill("hello");
  await page.getByTitle("选择 / 移动 (S)").click();
  await page.waitForTimeout(100);

  const redBounds = () => page.evaluate(() => {
    const canvas = document.querySelector(".screenshot-canvas");
    const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let minX = width;
    let minY = height;
    for (let y = 100; y < Math.min(height, 400); y++) {
      for (let x = 100; x < Math.min(width, 520); x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 180 && data[i + 1] < 110 && data[i + 2] < 110) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
        }
      }
    }
    return { x: minX, y: minY };
  });
  const before = await redBounds();
  assert(before.x < 230 && before.y < 230, `Text was not drawn: ${JSON.stringify(before)}`);

  await page.mouse.move(150, 160);
  await assert.doesNotReject(() => page.waitForFunction(() => document.querySelector(".screenshot-canvas")?.style.cursor === "move"));
  await page.mouse.move(400, 350);
  await page.waitForFunction(() => document.querySelector(".screenshot-canvas")?.style.cursor !== "move");
  await page.mouse.move(150, 160);
  await page.mouse.down();
  await page.mouse.move(288, 248, { steps: 8 });
  await page.mouse.up();
  const after = await redBounds();
  assert(after.x > before.x + 90 && after.y > before.y + 50, `Text did not move: ${JSON.stringify({ before, after })}`);
  assert(await page.getByTitle("文字 (T)").getAttribute("class")?.then((value) => value.includes("active")));

  await page.mouse.dblclick(after.x + 5, after.y + 5);
  const editor = page.locator(".screenshot-text-editor");
  await editor.waitFor();
  assert.equal(await editor.inputValue(), "hello");
  await editor.fill("edited");
  await page.getByTitle("选择 / 移动 (S)").click();
  await page.getByTitle("文字 (T)").click();
  await page.getByTitle("文字背景", { exact: true }).click();
  await page.getByTitle("文字背景颜色").fill("#00ff00");
  const corners = await page.evaluate(() => {
    const canvas = document.querySelector(".screenshot-canvas");
    const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const green = (x, y) => {
      const i = (y * width + x) * 4;
      return data[i] < 100 && data[i + 1] > 180 && data[i + 2] < 100;
    };
    let minX = width;
    let minY = height;
    for (let y = 100; y < 400; y++) {
      for (let x = 100; x < 520; x++) {
        if (green(x, y)) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
        }
      }
    }
    return { minX, minY, corner: green(minX, minY), top: green(minX + 8, minY + 1) };
  });
  assert(corners.minX < 520 && corners.minY < 400 && !corners.corner && corners.top, `Text background is not rounded: ${JSON.stringify(corners)}`);
  const beforeRegionMove = await redBounds();
  const grip = await page.getByRole("button", { name: "拖动截图区域" }).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  const afterRegionMove = await redBounds();
  assert.equal(afterRegionMove.x, beforeRegionMove.x + 60);
  assert.equal(afterRegionMove.y, beforeRegionMove.y + 40);
  await page.getByTitle("锁定到屏幕").click();
  await page.waitForFunction(() => window.__screenshotCalls.some((call) => call.command === "pin_screenshot"));
  const pinCall = await page.evaluate(() => window.__screenshotCalls.find((call) => call.command === "pin_screenshot"));
  assert.equal(pinCall.args.width, 420);
  assert.equal(pinCall.args.height, 300);
  assert.equal(pinCall.args.x, 160);
  assert.equal(pinCall.args.y, 140);
  assert(pinCall.args.dataUrl.startsWith("data:image/png;base64,"));

  await page.goto("http://127.0.0.1:1420/?window=screenshot-pin&pin=test-pin");
  const close = page.getByTitle("关闭贴图 (Esc)");
  await close.waitFor();
  const pinFrame = await page.locator(".screenshot-pin-root").evaluate((el) => ({
    rect: el.getBoundingClientRect().toJSON(),
    shadow: getComputedStyle(el).boxShadow,
    borderWidth: getComputedStyle(el, "::after").borderTopWidth,
    rootBackground: getComputedStyle(document.querySelector("#root")).backgroundColor
  }));
  assert.equal(pinFrame.rect.x, 10);
  assert.equal(pinFrame.rect.y, 10);
  assert.equal(pinFrame.rect.width, 1180);
  assert.notEqual(pinFrame.shadow, "none");
  assert(pinFrame.shadow.includes("rgba(0, 0, 0, 0.2)"));
  assert.equal(pinFrame.borderWidth, "1px");
  assert.equal(pinFrame.rootBackground, "rgba(0, 0, 0, 0)");
  assert(await close.evaluate((element) => getComputedStyle(element).opacity) === "1");
  if (process.env.VISUAL_QA) {
    await page.setViewportSize({ width: 480, height: 340 });
    await page.evaluate(() => { document.documentElement.style.backgroundColor = "#f4f5f6"; });
    await page.screenshot({ path: "src-tauri/target/release/qa-pin-soft-shadow.png" });
  }
  await close.click();
  await page.waitForFunction(() => window.__screenshotCalls.some((call) => call.command === "close_pinned_screenshot"));
  console.log("Screenshot text drag/edit, rounded background, pin region and visible close control: PASS");
} finally {
  await browser.close();
}
