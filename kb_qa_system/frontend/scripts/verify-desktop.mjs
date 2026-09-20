import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

// Isolated test data, never the user's WebView profile or actual model service.
const output = path.resolve("../../.tools/workbench-qa");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "webview-test-"));
const received = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  received.push({ url: request.url, body: JSON.parse(body), authorization: request.headers.authorization });
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: "Native model bridge verified." } }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const servicePort = server.address().port;
const app = spawn(path.resolve("src-tauri/target/release/geiit-workbench.exe"), [], {
  windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19227" },
  stdio: "ignore",
});
let browser;
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:19227", { timeout: 1000 }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  if (!browser) throw new Error("Desktop WebView did not become available");
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent("page", { timeout: 10000 });
  await expect(page.getByRole("heading", { name: "创建本机密钥库" })).toBeVisible();
  await page.getByLabel("解锁口令", { exact: true }).fill("1234");
  await page.getByLabel("确认口令", { exact: true }).fill("1234");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("连接名称", { exact: true }).fill("Desktop bridge test");
  await page.getByLabel("调用方式", { exact: true }).selectOption("local");
  await page.getByLabel("API Base URL", { exact: true }).fill(`http://127.0.0.1:${servicePort}/v1`);
  await page.getByLabel("模型名称", { exact: true }).fill("native-fixture-model");
  await page.getByLabel("API Key", { exact: true }).fill("native-fixture-key");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.getByText("连接已加密保存到本机。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("Verify native request.");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("Native model bridge verified.", { exact: true })).toBeVisible({ timeout: 10000 });
  expect(received).toHaveLength(1);
  expect(received[0].url).toBe("/v1/chat/completions");
  expect(received[0].authorization).toBe("Bearer native-fixture-key");
  expect(received[0].body.model).toBe("native-fixture-model");
  expect(received[0].body).not.toHaveProperty("max_tokens");
  await page.screenshot({ path: path.join(output, "desktop-native.png") });
  await page.reload();
  await expect(page.getByRole("heading", { name: "解锁工作台" })).toBeVisible();
  console.log(JSON.stringify({ passed: true, nativeRequests: received.length, screenshot: path.join(output, "desktop-native.png") }));
} finally {
  if (browser) await browser.close();
  app.kill();
  await new Promise((resolve) => server.close(resolve));
}
