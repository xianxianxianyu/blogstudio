import { useCallback, useState, useSyncExternalStore } from "react";
import { TAG_COLORS } from "../../src/tag/tag";
import type { Workspace } from "../../src/app/workspace";
import { CAPABILITIES, fieldSource } from "../../src/config/config";
import type { Capability, EndpointConfig } from "../../src/config/config";
import type { Settings } from "../../src/app/settings";
import { SETTINGS_PAGES, blocksOf, usersOf } from "../../src/app/settings-map";
import type { SettingsPage as PageId, Side } from "../../src/app/settings-map";
import { LocalEngineSection } from "./LocalModel";
import { RetentionNotice } from "./RetentionNotice";

/**
 * 设置页——外壳里与 Book / Context / Writer 平级的一样（ADR-0003 决策 3、ADR-0005）。
 *
 * **它自己不决定什么归哪一页**，那份归属表在 `src/app/settings-map.ts` 里，带测试。
 * 这里只是把它画出来，与别的视图同一条规矩（ADR-0013）。
 *
 * 此前这里是一个 `<dialog>` 覆盖层，里面一张长表把三种量程混在一起：全局的端点、
 * Book 的标记与清理、还有**手上这一本书**的目录。于是从 Context 那一侧点「设置」，
 * 「目录」整块消失而「标记」还在——同一个按钮在不同页面给出不同的表，读者无从判断
 * 哪些是全局的。分页之后每一页只说一件事，且那件事的归属是写下来的。
 */
export function SettingsPage({
  page,
  onPage,
  settings,
  ws,
  outline,
}: {
  page: PageId;
  onPage: (next: PageId) => void;
  settings: Settings;
  ws: Workspace;
  outline: OutlineProps;
}) {
  const config = useSyncExternalStore(
    useCallback((listener: () => void) => settings.subscribe(listener), [settings]),
    () => settings.config,
  );
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  /**
   * 每次改动都落盘，但**要说出来**。
   *
   * 此前这里是 `void settings.setDefault(...)`——返回的 Result 没人看，于是保存成功
   * 没有任何提示（读者无从判断存没存上），保存失败也完全静默。填完一栏什么都不发生，
   * 看起来就跟白填了一样。
   */
  const save = (run: () => Promise<{ ok: boolean; reason?: string }>) => {
    void run().then((result) => {
      setNote(result.ok ? { text: "已保存", bad: false } : { text: result.reason ?? "保存失败", bad: true });
    });
  };

  const spec = SETTINGS_PAGES.find((one) => one.id === page) ?? SETTINGS_PAGES[0];
  const blocks = blocksOf(spec.id, { bookOpen: outline.book !== null });

  return (
    <div className="settings">
      <header className="settings-bar">
        <h1>设置</h1>
        {/* 配置存在应用数据目录里，改完立刻落盘。这句话要写出来——读者填完一栏
            看不到任何反应时，第一个念头就是「是不是白填了」。 */}
        <p className="muted grow">
          改动立刻保存，下次打开还在。
          {note && <b className={note.bad ? "err" : undefined}> {note.text}</b>}
        </p>
      </header>

      <div className="settings-body">
        <nav className="settings-nav">
          {SETTINGS_PAGES.map((one) => (
            <button
              key={one.id}
              className={one.id === spec.id ? "on" : undefined}
              onClick={() => onPage(one.id)}
            >
              {one.title}
            </button>
          ))}
        </nav>

        <main className="settings-main">
          {blocks.length === 0 && <p className="empty">{spec.empty}</p>}

          {blocks.includes("endpoints") && <Endpoints config={config} settings={settings} save={save} />}

          {blocks.includes("tags") && <Tags ws={ws} save={save} />}

          {blocks.includes("retention") && (
            <>
              <RetentionNotice settings={settings} />
              <Retention days={config.retention.ttlDays} acknowledged={config.retention.acknowledged} settings={settings} save={save} />
            </>
          )}

          {blocks.includes("outline") && <Outline {...outline} />}
        </main>
      </div>
    </div>
  );
}

const FIELDS: { key: keyof EndpointConfig; label: string; secret?: boolean }[] = [
  { key: "baseURL", label: "地址" },
  { key: "apiKey", label: "Key", secret: true },
  { key: "model", label: "模型" },
];

/**
 * 每个能力一段说明。**键是 `Capability`，所以少写一个当场编译不过**——能力表和这里的
 * 文案不许分头漂，`CAPABILITIES` 里多一个而这里没有，是 `chat` 当初消失的走法。
 */
const COPY: Record<Capability, { label: string; hint: string }> = {
  recognition: { label: "识别", hint: "OCR、公式转 LaTeX、图理解。可以是本地端点。" },
  translation: { label: "翻译", hint: "通常换一个更快的文本模型（ADR-0010）。" },
  chat: { label: "问文档", hint: "单文档问答，材料是这一篇 PDF 的原文和你贴进去的摘录。" },
  writing: { label: "写作助手", hint: "材料是正在写的稿子加从知识库召回的 context，与问文档是两件事。" },
};

const SIDE_NAME: Record<Side, string> = { book: "Book", context: "Context", writer: "Writer" };

/**
 * 端点：默认组 + 每个能力的覆盖。**这一整块是三侧共用的那一份。**
 *
 * 能力按**任务**切，不按产品切（ADR-0010）。所以这里不按 Book / Writer 分栏，
 * 只在每个能力旁边标出「谁在用」——按产品分栏的话，「同一个端点、写作换个更大的模型」
 * 这种最常见的配法就得把地址和 key 再抄一遍。
 */
export function Endpoints({
  config,
  settings,
  save,
}: {
  config: Settings["config"];
  settings: Settings;
  save: (run: () => Promise<{ ok: boolean; reason?: string }>) => void;
}) {
  const [checking, setChecking] = useState<Capability | null>(null);
  const [checked, setChecked] = useState<Partial<Record<Capability, string>>>({});

  async function check(capability: Capability) {
    setChecking(capability);
    const result = await settings.check(capability);
    setChecked((previous) => ({ ...previous, [capability]: result.ok ? "通了" : result.reason }));
    setChecking(null);
  }

  return (
    <>
      <h3>默认组</h3>
      <p className="muted">没有单独配置的功能都用它。Book、Context、Writer 读的是同一份。</p>
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

      <LocalEngineSection
        enabled={config.localRecognition}
        onToggle={(next) => save(() => settings.setLocalRecognition(next))}
      />

      {CAPABILITIES.map((capability) => (
        <div key={capability}>
          <h3>
            {COPY[capability].label}{" "}
            {/* 谁在用这个能力。读者改「问文档」之前得先知道改的是哪一侧的东西——
                这正是「三侧设置不互通」那个错觉的解药：它们本来就是一份。 */}
            <span className="whose">{usersOf(capability).map((side) => SIDE_NAME[side]).join(" · ")}</span>{" "}
            <button className="btn" disabled={checking !== null} onClick={() => void check(capability)}>
              {checking === capability ? "试…" : "试一下"}
            </button>
          </h3>
          <p className="muted">{COPY[capability].hint}</p>
          {checked[capability] !== undefined && (
            <pre className={checked[capability] === "通了" ? undefined : "err"}>{checked[capability]}</pre>
          )}

          {FIELDS.map((field) => {
            const own = fieldSource(config, capability, field.key) === "own";
            const value = own ? (config.capabilities[capability]?.[field.key] ?? "") : config.default[field.key];
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
                      save(() => settings.setOverride(capability, field.key, event.target.value));
                    }
                  }}
                />
                {/* 必须能看出某一栏是「自己配的」还是「跟随默认组」，否则读者改了
                    默认组会意外影响到他以为已经独立配置的功能。 */}
                {own ? (
                  <button
                    className="btn"
                    title="改回跟随默认组"
                    onClick={() => save(() => settings.clearOverride(capability, field.key))}
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
    </>
  );
}

/**
 * 标记：颜色是它的身份，所以只能改名不能换色。改名只写 tags.md，已有摘录的颜色和
 * 归属都不变——它们存的是 id。
 */
function Tags({
  ws,
  save,
}: {
  ws: Workspace;
  save: (run: () => Promise<{ ok: boolean; reason?: string }>) => void;
}) {
  return (
    <>
      <h3>标记</h3>
      <p className="muted">阅读态的颜色分类。五色闭集，只能改名——颜色就是它的身份。</p>
      {TAG_COLORS.map((id) => (
        <label className="field" key={id}>
          {/* 色块是给眼睛认的，标记的可读名字给读屏器——只有一个色块的话，
              这一栏在读屏器里就是五个没有名字的输入框。 */}
          <span className="swatch" data-tag={id} aria-hidden="true" />
          <span className="sr-only">{id}</span>
          <input
            defaultValue={ws.state.tags.find((tag) => tag.id === id)?.name ?? ""}
            onBlur={(event) => save(() => ws.renameTag(id, event.target.value))}
          />
        </label>
      ))}
    </>
  );
}

function Retention({
  days,
  acknowledged,
  settings,
  save,
}: {
  days: number;
  acknowledged: boolean;
  settings: Settings;
  save: (run: () => Promise<{ ok: boolean; reason?: string }>) => void;
}) {
  return (
    <>
      <h3>自动清理</h3>
      <p className="muted">
        没标记为重要的摘录，多少天没打开就只保留位置标记。
        {acknowledged ? "" : "（你还没确认这条策略，目前不会清理任何东西。）"}
      </p>
      <label className="field">
        <span>天数</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={days}
          onBlur={(event) => {
            const next = Number(event.target.value);
            if (next !== days) save(() => settings.setRetentionDays(next));
          }}
        />
      </label>
    </>
  );
}

export interface OutlineProps {
  /** 书名。案头上没有活着的书时为 null，这一块整个不出现。 */
  book: string | null;
  count: number;
  /** 这份目录是不是**生成的**。PDF 自带的那份是文件里的事实，改了也存不回去。 */
  generated: boolean;
  onGenerate: () => void;
  onShift: (delta: number) => void;
  onClear: () => void;
}

/**
 * 这本书的目录。
 *
 * **放在设置里是个折中，要说清楚。** 目录是这本书的数据，不是应用的配置——按那条
 * 原则它该待在摘录栏。但摘录栏的入口只在「还没有目录」时出现，于是生成过一次之后
 * 就再也找不到重新生成的路；而「整体挪一页」又是在核对页码时才想起来要用的。
 * 两个动作都需要一个**一直在那儿**的地方。
 *
 * 既然是折中，边界就得守住：它归 Book 那一页，且只在手上真有一本书时才出现
 * （`settings-map.ts`，带测试）。
 */
function Outline({ book, count, generated, onGenerate, onShift, onClear }: OutlineProps) {
  return (
    <>
      <h3>目录</h3>
      <p className="muted">
        《{book}》
        {count === 0
          ? "还没有目录，摘录按页排。"
          : generated
            ? `有一份自动识别的目录，${count} 条。`
            : `用的是 PDF 自带的目录，${count} 条。`}
      </p>

      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn primary" onClick={onGenerate}>
          {count === 0 ? "从目录页生成" : "重新生成"}
        </button>
        {generated && (
          <button className="btn" onClick={onClear}>
            删掉这份
          </button>
        )}
      </div>

      {generated && (
        <>
          {/* 差一页是最常见的错，而它只在翻过去核对时才被发现——那时偏移早就烤进
              每一条里了。没有这个动作，读者只剩重跑一遍识别或手改几百条。 */}
          <p className="muted">整份页码一起挪。跳过去发现差一页时用它，不用重新识别。</p>
          <div className="row">
            <button className="btn" onClick={() => onShift(-1)}>
              −1 页
            </button>
            <button className="btn" onClick={() => onShift(1)}>
              +1 页
            </button>
          </div>
        </>
      )}
    </>
  );
}
