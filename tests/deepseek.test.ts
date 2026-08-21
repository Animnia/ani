import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRequestSize,
  createDeepSeekStream,
  DEEPSEEK_VISION_MODEL,
  detectImageMime,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
  toWire,
  toWireMessages,
} from "../src/core/deepseek.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("toWire preserves the existing text-only wire format", () => {
  assert.deepEqual(
    toWire({ role: "user", content: "hello", _meta: { ts: 1 } }),
    { role: "user", content: "hello" },
  );
});

test("toWire encodes a local image by magic bytes, not its extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-vision-"));
  try {
    const path = join(dir, "actually-png.jpg");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    assert.equal(detectImageMime(path), "image/png");
    const wire = toWire(
      { role: "user", content: "识别图片", images: [{ path, detail: "low" }] },
      DEEPSEEK_VISION_MODEL,
    );
    assert.deepEqual(wire, {
      role: "user",
      content: [
        { type: "text", text: "识别图片" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgoBAgM=", detail: "low" },
        },
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toWire recognizes every image format supported by DeepSeek Vision", () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-vision-"));
  try {
    const cases: [string, number[], string][] = [
      ["jpeg", [0xff, 0xd8, 0xff, 0x00], "image/jpeg"],
      ["gif", [...Buffer.from("GIF89a")], "image/gif"],
      ["webp", [...Buffer.from("RIFF0000WEBP")], "image/webp"],
    ];
    for (const [name, bytes, mime] of cases) {
      const path = join(dir, name + ".bin");
      writeFileSync(path, Buffer.from(bytes));
      const wire = toWire({ role: "user", content: "", images: [{ path }] }, DEEPSEEK_VISION_MODEL);
      const part = (wire.content as { image_url: { url: string } }[])[0];
      assert.match(part.image_url.url, new RegExp(`^data:${mime};base64,`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toWire supports remote image URLs and Files API ids", () => {
  const wire = toWire(
    {
      role: "user",
      content: "compare",
      images: [
        { url: "https://example.com/a.webp", detail: "original" },
        { fileId: "file-api-123" },
      ],
    },
    DEEPSEEK_VISION_MODEL,
  );
  assert.deepEqual(wire.content, [
    { type: "text", text: "compare" },
    { type: "image_url", image_url: { url: "https://example.com/a.webp", detail: "original" } },
    { type: "file", file_id: "file-api-123" },
  ]);
});

test("toWireMessages ignores images on a non-vision model without mutating history", () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-vision-switch-"));
  try {
    const path = join(dir, "switch.png");
    writeFileSync(path, PNG_1X1);
    const messages = [{ role: "user" as const, content: "remember this image", images: [{ path, detail: "auto" as const }] }];

    assert.deepEqual(toWireMessages(messages, "deepseek-v4-flash"), [
      { role: "user", content: "remember this image" },
    ]);
    assert.equal(messages[0].images[0].path, path, "the persisted history keeps its image reference");

    const vision = toWireMessages(messages, DEEPSEEK_VISION_MODEL);
    assert.ok(Array.isArray(vision[0].content), "switching back restores the visual input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toWire rejects images outside a vision user message", () => {
  assert.throws(
    () => toWire({ role: "user", content: "x", images: [{ url: "https://example.com/a.png" }] }, "deepseek-v4-flash"),
    /does not support images/,
  );
  assert.throws(
    () => toWire({ role: "assistant", content: "x", images: [{ url: "https://example.com/a.png" }] }, DEEPSEEK_VISION_MODEL),
    /only allowed in user messages/,
  );
});

test("toWire reports missing and unsupported local images clearly", () => {
  assert.throws(
    () => toWire({ role: "user", content: "x", images: [{ path: "definitely-missing.png" }] }, DEEPSEEK_VISION_MODEL),
    /Cannot read image/,
  );

  const dir = mkdtempSync(join(tmpdir(), "ani-vision-"));
  try {
    const path = join(dir, "not-an-image.bin");
    writeFileSync(path, "hello");
    assert.throws(
      () => toWire({ role: "user", content: "x", images: [{ path }] }, DEEPSEEK_VISION_MODEL),
      /Unsupported image format/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toWireMessages downgrades a missing historical image to basename-only text", () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-vision-missing-"));
  try {
    const path = join(dir, "deleted-picture.png");
    writeFileSync(path, PNG_1X1);
    const messages = [{ role: "user" as const, content: "old image", images: [{ path }] }];
    rmSync(path, { force: true });

    const wire = toWireMessages(messages, DEEPSEEK_VISION_MODEL);
    assert.equal(typeof wire[0].content, "string");
    assert.match(String(wire[0].content), /deleted-picture\.png/);
    assert.doesNotMatch(String(wire[0].content), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(messages[0].images?.[0] && "path" in messages[0].images[0] ? messages[0].images[0].path : "", path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toWire enforces the 32 MiB inline-image limit before reading the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-vision-"));
  try {
    const path = join(dir, "large.png");
    const fd = openSync(path, "w");
    try {
      writeFileSync(fd, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      ftruncateSync(fd, MAX_IMAGE_BYTES + 1);
    } finally {
      closeSync(fd);
    }
    assert.throws(
      () => toWire({ role: "user", content: "x", images: [{ path }] }, DEEPSEEK_VISION_MODEL),
      /32 MiB inline limit/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toWireMessages keeps newest images when multi-turn history exceeds 48 MiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-vision-"));
  try {
    const paths = [join(dir, "older.png"), join(dir, "newer.png")];
    for (const path of paths) {
      const fd = openSync(path, "w");
      try {
        writeFileSync(fd, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        ftruncateSync(fd, 18 * 1024 * 1024);
      } finally {
        closeSync(fd);
      }
    }
    const messages = paths.map((path, i) => ({ role: "user" as const, content: `image ${i}`, images: [{ path }] }));
    const wire = toWireMessages(messages, DEEPSEEK_VISION_MODEL);

    assert.equal(typeof wire[0].content, "string", "the older image is downgraded");
    assert.match(String(wire[0].content), /older\.png.*48 MiB request limit/);
    assert.ok(Array.isArray(wire[1].content), "the newest image remains visual");
    assert.match((wire[1].content as any[])[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(messages[0].images.length, 1, "request preparation never mutates session messages");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toWireMessages enforces the 600-image limit while preserving newest messages", () => {
  const messages = Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, (_, i) => ({
    role: "user" as const,
    content: `turn ${i}`,
    images: [{ url: `https://example.com/image-${i}.png` }],
  }));
  const wire = toWireMessages(messages, DEEPSEEK_VISION_MODEL);
  assert.equal(typeof wire[0].content, "string");
  assert.match(String(wire[0].content), /image-0\.png.*600-image request limit/);
  assert.ok(Array.isArray(wire.at(-1)!.content), "the newest image is retained");
});

test("createDeepSeekStream sends a real 1x1 PNG in the local HTTP request body", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ani-vision-http-"));
  const path = join(dir, "pixel.png");
  writeFileSync(path, PNG_1X1);
  let captured: any;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([
        'data: {"choices":[{"delta":{"content":"看到了"},"finish_reason":"stop"}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const stream = createDeepSeekStream({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 5_000,
    });
    const result = await stream({
      model: DEEPSEEK_VISION_MODEL,
      messages: [{ role: "user", content: "识别", images: [{ path, detail: "auto" }] }],
      tools: [],
    });

    assert.equal(result.content, "看到了");
    assert.equal(captured.model, DEEPSEEK_VISION_MODEL);
    assert.deepEqual(captured.messages[0].content[0], { type: "text", text: "识别" });
    assert.equal(
      captured.messages[0].content[1].image_url.url,
      `data:image/png;base64,${PNG_1X1.toString("base64")}`,
    );
    assert.equal(captured.messages[0].content[1].image_url.detail, "auto");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request-body size check uses UTF-8 bytes", () => {
  assert.doesNotThrow(() => assertRequestSize("你好", 6));
  assert.throws(() => assertRequestSize("你好", 5), /request body exceeds 48 MiB/);
});
