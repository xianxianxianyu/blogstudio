import { describe, expect, it } from "vitest";
import { createFixedPromptRecognitionClient } from "./fixed-prompt-recognition";
import { createFakeModelClient } from "../../test/fake-model-client";
import { createRecognizer } from "../recognizer/recognizer";
import { openFixturePdf } from "../../test/fixtures";

const PNG = { mime: "image/png" as const, bytes: new Uint8Array([0x89, 0x50]), width: 10, height: 10 };

const request = () => ({
  messages: [{ role: "user" as const, content: "读这个区域，判断它属于哪一类，返回 JSON。……" }],
  images: [PNG],
});

describe("固定 prompt 识别 adapter", () => {
  it("把我们的 JSON 契约请求换成模型认识的固定 prompt，图照旧送过去", async () => {
    const local = createFakeModelClient({ completeText: "Deep residual learning" });
    const client = createFixedPromptRecognitionClient(local);

    await client.complete(request());

    // PaddleOCR-VL 这类专用识别模型只认六个固定 prompt，看不懂我们那段 JSON 契约。
    expect(local.completeCalls[0].messages).toEqual([{ role: "user", content: "OCR:" }]);
    expect(local.completeCalls[0].images).toEqual([PNG]);
  });

  it("把纯文本输出包回我们的 JSON 契约", async () => {
    const local = createFakeModelClient({ completeText: "Deep residual learning" });
    const client = createFixedPromptRecognitionClient(local);

    const { text } = await client.complete(request());

    // 专用模型不做分类。有字就报 mixed——它允许原文与译文，而译文由翻译模块另出。
    expect(JSON.parse(text)).toEqual({
      kind: "mixed",
      sourceText: "Deep residual learning",
      multimodal: null,
    });
  });
});

describe("固定 prompt 识别 adapter — 接进 Recognizer", () => {
  it("认不出字的区域走完整条链路后 sourceText 是 null，入库 blocked", async () => {
    const document = await openFixturePdf("2006.11239.pdf");
    // 专用识别模型对纯照片认不出字，回空。
    const local = createFakeModelClient({ completeText: "   " });
    const recognizer = createRecognizer({
      document,
      recognition: createFixedPromptRecognitionClient(local),
    });

    const content = await recognizer.recognize({
      page: 1,
      rect: { x: 110, y: 792 - 690, width: 390, height: 210 },
      pixels: PNG,
    });

    expect(content.route).toBe("vision");
    // adapter 合成 kind:'image'，Recognizer 的路由表随即把 sourceText 归零——
    // 两层各自独立地守住了「纯图不可入库」。
    expect(content.sourceText).toBeNull();
    expect(local.completeCalls).toHaveLength(1);
  });
});
