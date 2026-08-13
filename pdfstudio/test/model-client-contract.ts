import { describe, expect, it } from "vitest";
import { ModelError } from "../src/model/model-client";
import type { ModelClient } from "../src/model/model-client";

/** 一次被脚本化的模型回答。两个 adapter 用各自的方式实现同一份脚本。 */
export interface ModelScript {
  /** complete 返回的完整文本；也是 streamComplete 累积后的结果。 */
  text: string;
  /** streamComplete 的切分方式。省略则整段一次给出。 */
  deltas?: string[];
}

/**
 * ModelClient 的共享契约。生产 adapter 与测试 fake 各跑一遍——
 * 一个缝上有两个实现才算真缝（architecture.md「seam 纪律」），
 * 而两个实现只有守同一份契约，fake 才是可信的替身。
 */
export function describeModelClientContract(
  name: string,
  createClient: (script: ModelScript) => ModelClient,
): void {
  describe(`ModelClient 契约 — ${name}`, () => {
    it("complete 返回完整文本", async () => {
      const client = createClient({ text: "四张人脸样本" });

      expect((await client.complete({ messages: [{ role: "user", content: "hi" }] })).text).toBe(
        "四张人脸样本",
      );
    });

    it("streamComplete 的增量累积起来等于同一段文本", async () => {
      const client = createClient({ text: "四张人脸样本", deltas: ["四张", "人脸", "样本"] });

      const deltas: string[] = [];
      for await (const chunk of client.streamComplete({
        messages: [{ role: "user", content: "hi" }],
      })) {
        deltas.push(chunk.textDelta);
      }

      expect(deltas.join("")).toBe("四张人脸样本");
      expect(deltas.length).toBeGreaterThan(1);
    });

    it("空回答一律映射成 ModelError{empty-response}", async () => {
      const client = createClient({ text: "" });

      const error = await client
        .complete({ messages: [{ role: "user", content: "hi" }] })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe("empty-response");
    });
  });
}
