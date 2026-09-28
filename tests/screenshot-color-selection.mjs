import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });

await page.addInitScript(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 2400;
  canvas.height = 1600;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#123456";
  ctx.fillRect(0, 0, 1200, 1600);
  ctx.fillStyle = "#abcdef";
  ctx.fillRect(1200, 0, 1200, 1600);
  const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (char) => char.charCodeAt(0));
  window.__screenshotCalls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.__screenshotCalls.push({ command, args });
      if (command === "get_screenshot_monitor") {
        return { sessionId: "test", monitorIndex: 0, name: "Test", x: 0, y: 0, width: 2400, height: 1600, scaleFactor: 2, isPrimary: true };
      }
      if (command === "get_screenshot_image") return bytes;
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
  await page.mouse.move(500, 400);
  await page.mouse.up();

  await page.mouse.move(300, 150);
  const widthInput = page.getByRole("spinbutton", { name: "截图宽度" });
  const heightInput = page.getByRole("spinbutton", { name: "截图高度" });
  await page.waitForFunction(() => document.querySelector("[data-test-hover-color]")?.textContent === "#123456");
  assert.equal(await widthInput.inputValue(), "800");
  assert.equal(await heightInput.inputValue(), "600");
  assert.equal(await page.locator(".screenshot-copy-color").count(), 0);
  assert((await page.locator(".screenshot-size-label").innerText()).includes("空格键复制"));
  if (process.env.VISUAL_QA) await page.screenshot({ path: "src-tauri/target/release/qa-screenshot-color.png" });
  await page.keyboard.press("Space");
  assert(await page.evaluate(() => window.__screenshotCalls.some((call) => call.command === "copy_screenshot_color" && call.args.color === "#123456")));

  await page.mouse.move(900, 200);
  await page.waitForFunction(() => document.querySelector("[data-test-hover-color]")?.textContent === "#ABCDEF");
  await page.keyboard.press("Space");
  assert(await page.evaluate(() => window.__screenshotCalls.some((call) => call.command === "copy_screenshot_color" && call.args.color === "#ABCDEF")));

  const grip = page.getByRole("button", { name: "拖动截图区域" });
  const label = page.locator(".screenshot-size-label");
  const dragRegion = async (dx, dy) => {
    const box = await grip.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    assert.equal(await grip.evaluate((el) => getComputedStyle(el).cursor), "grab");
    await page.mouse.down();
    assert.equal(await grip.evaluate((el) => getComputedStyle(el).cursor), "grabbing");
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
    assert.equal(await grip.evaluate((el) => getComputedStyle(el).cursor), "grab");
    assert.equal(await widthInput.inputValue(), "800");
    assert.equal(await heightInput.inputValue(), "600");
  };
  // The grip moves the region even while an annotation tool is active and retains pointer capture.
  await page.getByTitle("画笔 (P)").click();
  await dragRegion(80, 60);
  let box = await label.boundingBox();
  assert.equal(box.x, 180);
  assert.equal(box.y, 124);
  await dragRegion(-80, -60);
  await dragRegion(-500, -400);
  box = await label.boundingBox();
  assert.equal(box.x, 4);
  assert.equal(box.y, 4);
  await dragRegion(2000, 1200);
  box = await label.boundingBox();
  assert.equal(box.x, 800);
  assert.equal(box.y, 464);
  await dragRegion(-700, -400);
  await page.getByTitle("选择 / 移动 (S)").click();

  await page.mouse.move(300, 100);
  await page.waitForFunction(() => document.querySelector(".screenshot-canvas")?.style.cursor === "ns-resize");
  await page.mouse.down();
  await page.mouse.move(300, 80);
  await page.mouse.up();
  assert.equal(await widthInput.inputValue(), "800");
  assert.equal(await heightInput.inputValue(), "640");

  await page.mouse.move(100, 250);
  await page.waitForFunction(() => document.querySelector(".screenshot-canvas")?.style.cursor === "ew-resize");
  await page.mouse.down();
  await page.mouse.move(80, 250);
  await page.mouse.up();
  assert.equal(await widthInput.inputValue(), "840");
  assert.equal(await heightInput.inputValue(), "640");

  const copyCount = await page.evaluate(() => window.__screenshotCalls.filter((call) => call.command === "copy_screenshot_color").length);
  await widthInput.fill("321");
  await widthInput.press("Space");
  assert.equal(await page.evaluate(() => window.__screenshotCalls.filter((call) => call.command === "copy_screenshot_color").length), copyCount);
  await heightInput.fill("201");
  await heightInput.press("Enter");
  assert.equal(await widthInput.inputValue(), "321");
  assert.equal(await heightInput.inputValue(), "201");
  assert.equal(await page.evaluate(() => window.__screenshotCalls.filter((call) => call.command === "complete_screenshot").length), 0);

  await widthInput.fill("0");
  await widthInput.press("Enter");
  await page.locator(".screenshot-error").waitFor();
  await widthInput.press("Escape");
  assert.equal(await widthInput.inputValue(), "321");
  assert.equal(await page.evaluate(() => window.__screenshotCalls.filter((call) => call.command === "cancel_screenshot").length), 0);

  // Enlarging near an edge keeps the requested pixel dimensions and moves the region to fit.
  await widthInput.fill("2400");
  await heightInput.fill("1600");
  await heightInput.press("Enter");
  assert.equal(await widthInput.inputValue(), "2400");
  assert.equal(await heightInput.inputValue(), "1600");
  const fullLabel = await label.boundingBox();
  const fullToolbar = await page.locator(".screenshot-toolbar").boundingBox();
  assert(fullToolbar.y >= fullLabel.y + fullLabel.height, "Toolbar overlaps the region grip on a full-desktop selection");
  if (process.env.VISUAL_QA) await page.screenshot({ path: "src-tauri/target/release/qa-screenshot-region-full.png" });
  await widthInput.fill("321");
  await heightInput.fill("201");
  await heightInput.press("Enter");

  await page.mouse.dblclick(100, 60);
  await page.waitForFunction(() => window.__screenshotCalls.some((call) => call.command === "complete_screenshot"));
  const finish = await page.evaluate(() => window.__screenshotCalls.find((call) => call.command === "complete_screenshot"));
  assert.equal(finish.args.copyToClipboard, true);
  assert(finish.args.dataUrl.startsWith("data:image/png;base64,"));
  const dimensions = await page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, finish.args.dataUrl);
  assert.deepEqual(dimensions, { width: 321, height: 201 });
  console.log("Screenshot region grip, edge clamping, Space color copy, exact pixel dimensions and double-click completion: PASS");
} finally {
  await browser.close();
}
