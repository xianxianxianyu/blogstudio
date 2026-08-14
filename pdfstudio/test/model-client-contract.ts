import { describe, expect, it } from "vitest";
import { ModelError } from "../src/model/model-client";
import type { ModelClient } from "../src/model/model-client";

/** 一次被脚本化的模型回答。两个 adapter 用各自的方式实现同一份脚本。 */
export interface ModelScript {
  /** complete 返回的完整文本；也是 streamComplete 累积后的结果。 */
  text: string;
  /** streamComplete 的切分方式。省略则整段一次给出。 */
  deltas?: string[];
  /** 吐完 deltas 后远端流不结束，等 abort 来掐。 */
  hang?: boolean;
  /** 远端回的东西根本解析不了。 */
  malformed?: boolean;
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

    // ADR-0009 后果段点名要覆盖「增量、abort、空流和中途失败」。前两条在上面，
    // 后两条在下面——只在生产 adapter 单侧断言的话，fake 的对应分支无人守护，
    // 而 fake 一旦比真端点宽容，用它写的测试就会说谎。
    it("取消时流优雅结束、不抛，已收到的部分保留", async () => {
      const client = createClient({ text: "四张人脸样本", deltas: ["四张", "人脸", "样本"], hang: true });
      const controller = new AbortController();

      const deltas: string[] = [];
      for await (const chunk of client.streamComplete({
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      })) {
        deltas.push(chunk.textDelta);
        if (deltas.length === 1) controller.abort();
      }

      // 关键断言是「循环走到了这里」——远端流永不结束，abort 没生效就会挂到超时。
      expect(controller.signal.aborted).toBe(true);
      expect(deltas.length).toBeGreaterThan(0);
      expect("四张人脸样本".startsWith(deltas.join(""))).toBe(true);
    });

    it("流中途坏掉映射成 ModelError，不漏底层解析错误", async () => {
      const client = createClient({ text: "", malformed: true });

      const drain = async () => {
        for await (const chunk of client.streamComplete({
          messages: [{ role: "user", content: "hi" }],
        })) {
          void chunk;
        }
      };

      const error = await drain().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ModelError);
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
