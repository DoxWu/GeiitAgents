import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const output = path.resolve("../../.tools/workbench-qa");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, timeout: 30_000 });
const context = await browser.newContext({ viewport: { width: 1200, height: 820 }, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
const requests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => requests.push(request.url()));
let delayed;
let release;
const calls = [];
await page.route("http://127.0.0.1:11434/v1/chat/completions", async (route) => {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
    return;
  }
  const body = route.request().postDataJSON();
  calls.push(body);
  if (body.messages[0].content === "task A") {
    delayed = true;
    await new Promise((resolve) => { release = resolve; });
  }
  await route.fulfill({ json: { choices: [{ message: { content: body.messages[0].content === "task A" ? "Answer A" : "Answer B" } }] }, headers: { "Access-Control-Allow-Origin": "*" } });
});

try {
  await page.goto("http://127.0.0.1:1420/workbench");
  await expect(page.getByRole("heading", { name: "创建本机密钥库" })).toBeVisible();
  await expect(page.locator("header")).toHaveCSS("border-bottom-color", "rgb(229, 229, 228)");
  await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeHidden();
  await page.getByLabel("解锁口令", { exact: true }).fill("verification-passphrase-123");
  await page.getByLabel("确认口令", { exact: true }).fill("verification-passphrase-123");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("连接名称", { exact: true }).fill("Local test");
  await page.getByLabel("调用方式", { exact: true }).selectOption("local");
  await page.getByLabel("模型名称", { exact: true }).fill("local-test-model");
  await page.getByLabel("API Key", { exact: true }).fill("qa-fixture-key-not-real");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.getByText("连接已加密保存到本机。", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, "models-desktop.png") });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("task A");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => delayed).toBe(true);
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("task B");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("Answer B", { exact: true })).toBeVisible();
  release();
  await page.getByRole("button", { name: "task A", exact: true }).click();
  await expect(page.getByText("Answer A", { exact: true })).toBeVisible();
  await expect(page.getByText("Answer B", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(output, "chat-desktop.png") });
  await page.getByRole("tab", { name: "文档", exact: true }).click();
  await page.getByLabel("选择 Markdown 文件").setInputFiles({ name: "meeting.md", mimeType: "text/markdown", buffer: Buffer.from("# Meeting notes\n\n| Owner | Task |\n|---|---|\n| Alice | Review report |\n\n![external image](https://tracker.invalid/track.png)\n\n<script>alert('unsafe')</script>") });
  await expect(page.getByRole("heading", { name: "Meeting notes" })).toBeVisible();
  await expect(page.locator(".private-markdown img, .private-markdown script")).toHaveCount(0);
  await page.screenshot({ path: path.join(output, "markdown-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "markdown-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await page.screenshot({ path: path.join(output, "models-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "解锁工作台" })).toBeVisible();
  await page.getByLabel("解锁口令", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("口令错误");
  await page.getByLabel("解锁口令", { exact: true }).fill("verification-passphrase-123");
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByText("Answer B", { exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain("qa-fixture-key-not-real");
  expect(storage).not.toContain("verification-passphrase-123");
  expect(storage).not.toContain("Answer A");
  expect(requests.some((url) => url.includes("tracker.invalid"))).toBe(false);
  expect(requests.some((url) => url.includes("/private-models/"))).toBe(false);
  expect(calls).toHaveLength(2);
  expect(calls[0]).not.toHaveProperty("max_tokens");
  expect(calls[1].messages.map((message) => message.content)).toEqual(["task B"]);
  expect(errors).toEqual([]);
  for (const allowed of [true, false]) {
    const accountContext = await browser.newContext({ viewport: { width: 1200, height: 820 } });
    await accountContext.addInitScript(({ allowed }) => {
      const user = { id: 42, username: "test", email: "test@example.com", is_active: true, is_superuser: false, user_type: allowed ? "regular" : "guest", created_at: "" };
      localStorage.setItem("kb_auth_tokens", JSON.stringify({ access_token: "qa-account-token", user }));
      localStorage.setItem("kb_auth_user", JSON.stringify(user));
    }, { allowed });
    const accountPage = await accountContext.newPage();
    const cloudCalls = [];
    await accountPage.route("**/api/v1/private-models/account", (route) => route.fulfill({ json: allowed ? { available: true, model: "server-model" } : { available: false }, headers: { "Access-Control-Allow-Origin": "*" } }));
    await accountPage.route("**/api/v1/private-models/account/complete", (route) => {
      cloudCalls.push(route.request().postDataJSON());
      expect(route.request().headers()["x-model-api-key"]).toBeUndefined();
      return route.fulfill({ json: { content: "Account cloud reply", model: "server-model" }, headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await accountPage.goto("http://127.0.0.1:1420/workbench");
    await accountPage.getByLabel("解锁口令", { exact: true }).fill("1234");
    await accountPage.getByLabel("确认口令", { exact: true }).fill("1234");
    await accountPage.getByRole("button", { name: "创建", exact: true }).click();
    await accountPage.getByRole("textbox", { name: "消息", exact: true }).fill("Account task");
    if (allowed) {
      await expect(accountPage.getByRole("combobox", { name: "当前对话模型" })).toHaveValue("$account");
      await accountPage.getByRole("button", { name: "发送", exact: true }).click();
      await expect(accountPage.getByText("Account cloud reply", { exact: true })).toBeVisible();
      expect(cloudCalls).toEqual([{ messages: [{ role: "user", content: "Account task" }] }]);
      await accountPage.screenshot({ path: path.join(output, "account-cloud-desktop.png") });
      await accountPage.setViewportSize({ width: 390, height: 844 });
      await accountPage.screenshot({ path: path.join(output, "account-cloud-mobile.png") });
      expect(await accountPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } else {
      await expect(accountPage.getByText("当前账号没有可用的云端模型。", { exact: true })).toBeVisible();
      await expect(accountPage.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
      expect(cloudCalls).toHaveLength(0);
    }
    await accountContext.close();
  }
  console.log(JSON.stringify({ passed: true, screenshots: output, modelRequests: calls.length, pageErrors: errors }));
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") });
  throw error;
} finally { await browser.close(); }
