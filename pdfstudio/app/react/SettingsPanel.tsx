import { useCallback, useState, useSyncExternalStore } from "react";
import { fieldSource } from "../../src/config/config";
import type { Capability, EndpointConfig } from "../../src/config/config";
import type { Settings } from "../../src/app/settings";
import { LocalEngineSection } from "./LocalModel";

/** 只列真正在用的三个。chat / claim 等接上了再加，先摆出来只会让人以为它们已经生效。 */
const CAPABILITIES: { key: Capability; label: string; hint: string }[] = [
  { key: "recognition", label: "识别", hint: "OCR、公式转 LaTeX、图理解。可以是本地端点。" },
  { key: "translation", label: "翻译", hint: "通常换一个更快的文本模型（ADR-0010）。" },
  { key: "embedding", label: "检索向量", hint: "本地 embeddinggemma 走的是另一条路，这里先留位。" },
];

const FIELDS: { key: keyof EndpointConfig; label: string; secret?: boolean }[] = [
  { key: "baseURL", label: "地址" },
  { key: "apiKey", label: "Key", secret: true },
  { key: "model", label: "模型" },
];

export function SettingsPanel({ settings }: { settings: Settings }) {
  const config = useSyncExternalStore(
    useCallback((listener: () => void) => settings.subscribe(listener), [settings]),
    () => settings.config,
  );
  const [checking, setChecking] = useState<Capability | null>(null);
  const [checked, setChecked] = useState<Partial<Record<Capability, string>>>({});
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  /**
   * 每次改动都落盘，但**要说出来**。
   *
   * 此前这里是 `void settings.setDefault(...)`——返回的 Result 没人看，于是保存成功
   * 没有任何提示（读者无从判断存没存上），保存失败也完全静默。填完一栏什么都不发生，
   * 看起来就跟白填了一样。
   */
  function save(run: () => Promise<{ ok: boolean; reason?: string }>) {
    void run().then((result) => {
      setNote(result.ok ? { text: "已保存", bad: false } : { text: result.reason ?? "保存失败", bad: true });
    });
  }

  async function check(capability: Capability) {
    setChecking(capability);
    const result = await settings.check(capability);
    setChecked((previous) => ({ ...previous, [capability]: result.ok ? "通了" : result.reason }));
    setChecking(null);
  }

  return (
    <div>
      {/* 配置存在应用数据目录里，改完立刻落盘，下次打开还在。这句话要写出来
          ——读者填完一栏看不到任何反应时，第一个念头就是「是不是白填了」。 */}
      <p className="muted">
        改动立刻保存，下次打开还在。
        {note && <b className={note.bad ? "err" : undefined}> {note.text}</b>}
      </p>

      <LocalEngineSection
        enabled={config.localRecognition}
        onToggle={(next) => save(() => settings.setLocalRecognition(next))}
      />

      <h3>自动清理</h3>
      <p className="muted">
        没标记为重要的摘录，多少天没打开就只保留位置标记。
        {config.retention.acknowledged ? "" : "（你还没确认这条策略，目前不会清理任何东西。）"}
      </p>
      <label className="field">
        <span>天数</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={config.retention.ttlDays}
          onBlur={(event) => {
            const days = Number(event.target.value);
            if (days !== config.retention.ttlDays) {
              save(() => settings.setRetentionDays(days));
            }
          }}
        />
      </label>

      <h3>默认组</h3>
      <p className="muted">没有单独配置的功能都用它。</p>
      {FIELDS.map((field) => (
        <label key={field.key} className="field">
          <span>{field.label}</span>
          <input
            type={field.secret ? "password" : "text"}
            defaultValue={config.default[field.key]}
            onBlur={(event) => {
              if (event.target.value !== config.default[field.key]) {
                save(() => settings.setDefault(field.key, event.target.value));
              }
            }}
          />
        </label>
      ))}

      {CAPABILITIES.map((capability) => (
        <div key={capability.key}>
          <h3>
            {capability.label}{" "}
            <button
              className="btn"
              disabled={checking !== null}
              onClick={() => void check(capability.key)}
            >
              {checking === capability.key ? "试…" : "试一下"}
            </button>
          </h3>
          <p className="muted">{capability.hint}</p>
          {checked[capability.key] !== undefined && (
            <pre className={checked[capability.key] === "通了" ? undefined : "err"}>
              {checked[capability.key]}
            </pre>
          )}

          {FIELDS.map((field) => {
            const own = fieldSource(config, capability.key, field.key) === "own";
            const value = own
              ? (config.capabilities[capability.key]?.[field.key] ?? "")
              : config.default[field.key];
            return (
              <label key={field.key} className="field">
                <span>{field.label}</span>
                <input
                  // key 绑到「是不是自己配的」上：清掉覆盖之后要让输入框重挂，
                  // 否则它会继续显示读者刚删掉的那个值。
                  key={`${String(own)}-${value}`}
                  type={field.secret ? "password" : "text"}
                  defaultValue={value}
                  placeholder={own ? "" : "跟随默认组"}
                  className={own ? "own" : "inherited"}
                  onBlur={(event) => {
                    if (event.target.value !== value) {
                      save(() => settings.setOverride(capability.key, field.key, event.target.value));
                    }
                  }}
                />
                {/* 必须能看出某一栏是「自己配的」还是「跟随默认组」，否则读者改了
                    默认组会意外影响到他以为已经独立配置的功能。 */}
                {own ? (
                  <button
                    className="btn"
                    title="改回跟随默认组"
                    onClick={() => save(() => settings.clearOverride(capability.key, field.key))}
                  >
                    ↩
                  </button>
                ) : (
                  <span className="muted">跟随默认</span>
                )}
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
