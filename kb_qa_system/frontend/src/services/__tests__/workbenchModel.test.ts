import { afterEach, expect, it, vi } from "vitest";
import { completeModel, validateProfile } from "../workbenchModel";
import { apiClient, getStoredTokens } from "@/api/client";
import type { ModelProfile } from "@/types/workbench";

vi.mock("@/api/client", () => ({ apiClient: { post: vi.fn() }, getStoredTokens: vi.fn(() => ({ access_token: "account-token" })) }));
const profile: ModelProfile = { id: "test", name: "test", mode: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "test", hasKey: false };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([undefined, 100000])("omits an unset limit and preserves an explicit one in browser requests (%s)", async (limit) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
  vi.stubGlobal("fetch", fetcher);
  await completeModel({ ...profile, maxTokens: limit }, "", [{ role: "user", content: "hello" }], new AbortController().signal);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  if (limit === undefined) expect(body).not.toHaveProperty("max_tokens");
  else expect(body.max_tokens).toBe(limit);
});

it("omits an unset limit from the serialized relay payload", async () => {
  vi.mocked(getStoredTokens).mockReturnValue({ access_token: "test" } as ReturnType<typeof getStoredTokens>);
  vi.mocked(apiClient.post).mockResolvedValue({ content: "ok" });
  await completeModel({ ...profile, mode: "relay", baseUrl: "https://models.example/v1" }, "fixture", [{ role: "user", content: "hi" }], new AbortController().signal);
  expect(JSON.parse(JSON.stringify(vi.mocked(apiClient.post).mock.calls[0][1]))).not.toHaveProperty("max_tokens");
});

it.each([0, -1, 1.5, NaN, 2147483648])("rejects an invalid explicit limit (%s)", (limit) => {
  expect(() => validateProfile({ ...profile, maxTokens: limit })).toThrow();
});

it('renders OpenAI-compatible local SSE chunks incrementally and returns the same final text', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { const encoder = new TextEncoder(); chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk))); controller.close(); },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
  const received: string[] = [];
  await expect(completeModel(profile, '', [{ role: 'user', content: 'hello' }], new AbortController().signal, chunk => received.push(chunk))).resolves.toBe('你好，世界');
  expect(received).toEqual(['你好', '，世界']);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1].body)).stream).toBe(true);
});
