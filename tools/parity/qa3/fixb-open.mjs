// FIX-B: opens a plan file through the + menu's "Open plan file..." and drops one on the board.
import fs from "node:fs";
import { fresh, OUT } from "./lib.mjs";
const file = process.argv[2] ?? "fixtures/biodiesel-demo.json";
const { browser, page, logs } = await fresh();
const before = await page.locator(".mt-tab").count();
await page.getByLabel("New plan", { exact: true }).first().click();
await page.screenshot({ path: OUT + "fixb-plus.png", clip: { x: 0, y: 0, width: 700, height: 200 } });
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.getByText("Open plan file...").click(),
]);
await chooser.setFiles(file);
await page.waitForTimeout(6000);
console.log("tabs", before, "->", await page.locator(".mt-tab").count(), "nodes", await page.locator(".react-flow__node").count());
await page.screenshot({ path: OUT + "fixb-open.png" });
// drop a .json on the board
const text = fs.readFileSync(file, "utf8");
const dt = await page.evaluateHandle(([t]) => { const d = new DataTransfer(); d.items.add(new File([t], "dropped.json", { type: "application/json" })); return d; }, [text]);
await page.dispatchEvent(".react-flow", "drop", { dataTransfer: dt, clientX: 800, clientY: 500 });
await page.waitForTimeout(5000);
console.log("after drop tabs", await page.locator(".mt-tab").count());
// picture drop
const pic = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File([new Uint8Array([1,2,3])], "x.png", { type: "image/png" })); return d; });
await page.dispatchEvent(".react-flow", "drop", { dataTransfer: pic, clientX: 800, clientY: 500 });
await page.waitForTimeout(800);
await page.screenshot({ path: OUT + "fixb-picdrop.png" });
console.log((await page.locator(".rail-notice").allInnerTexts()).join(" | "));
console.log(logs.filter((l) => !/503|trailer/.test(l)).join("\n"));
await browser.close();
