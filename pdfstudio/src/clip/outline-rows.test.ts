import { describe, expect, it } from "vitest";
import { outlineRows } from "./outline-rows";
import type { ClipGroup, Section } from "./outline";
import type { Clip } from "./clip";

const clip = (id: string) => ({ id }) as Clip;

/** level 拼出一棵树：0 是章，1 是节，2 是小节。 */
function group(title: string, level: number, clips: string[] = []): ClipGroup {
  return {
    section: { title, page: 1, y: null, level, path: [] } as Section,
    clips: clips.map(clip),
  };
}

const before = (clips: string[] = []): ClipGroup => ({ section: null, clips: clips.map(clip) });

const shown = (rows: { group: ClipGroup }[]) => rows.map((r) => r.group.section?.title ?? "（之前）");

//   第1章
//     1.1
//       1.1.1  [a]
//     1.2
//   第2章
const BOOK: ClipGroup[] = [
  group("第1章", 0),
  group("1.1", 1),
  group("1.1.1", 2, ["a"]),
  group("1.2", 1),
  group("第2章", 0),
];

describe("目录行（折叠）", () => {
  it("顶层永远看得见", () => {
    const rows = outlineRows([group("第1章", 0), group("第2章", 0)], new Set());
    expect(shown(rows)).toEqual(["第1章", "第2章"]);
  });

  it("默认折起：没有摘录的书只看得到顶层——两三百条不会糊一脸", () => {
    const rows = outlineRows(
      [group("第1章", 0), group("1.1", 1), group("1.1.1", 2), group("第2章", 0)],
      new Set(),
    );
    expect(shown(rows)).toEqual(["第1章", "第2章"]);
  });

  it("**有摘录的小节默认展开，祖先跟着展开**——否则划过的东西藏在折叠里等于没有", () => {
    expect(shown(outlineRows(BOOK, new Set()))).toEqual(["第1章", "1.1", "1.1.1", "1.2", "第2章"]);
  });

  it("展开的是祖先链，不是整棵树：别的章不受影响", () => {
    const rows = outlineRows([...BOOK, group("2.1", 1)], new Set());
    expect(shown(rows)).not.toContain("2.1");
  });

  it("折上祖先，整条子孙链跟着消失——哪怕子孙自己是展开的", () => {
    const rows = outlineRows(BOOK, new Set([0])); // 折上「第1章」
    expect(shown(rows)).toEqual(["第1章", "第2章"]);
  });

  it("折起**中间层**的小节，只吞自己的子孙，不吞同级的兄弟", () => {
    // 折 1.1（它拥有 1.1.1）。1.2 与它同级，必须还在。
    const rows = outlineRows(BOOK, new Set([1]));

    expect(shown(rows)).toEqual(["第1章", "1.1", "1.2", "第2章"]);
  });

  it("点一下翻转默认值：默认折起的展开", () => {
    const flat = [group("第1章", 0), group("1.1", 1)];
    expect(shown(outlineRows(flat, new Set([0])))).toEqual(["第1章", "1.1"]);
  });

  it("数量算上子孙——折起来时「第12章我划过吗」必须还答得出", () => {
    const rows = outlineRows(BOOK, new Set([0]));
    expect(rows.find((r) => r.group.section?.title === "第1章")?.clipCount).toBe(1);
  });

  it("**标题底下有东西就能折**——子小节算，自己的摘录也算", () => {
    const rows = outlineRows(
      [group("有子节", 0), group("1.1", 1), group("只有摘录", 0, ["a", "b"]), group("空的", 0)],
      new Set(),
    );
    const foldable = (t: string) => rows.find((r) => r.group.section?.title === t)?.foldable;

    expect(foldable("有子节")).toBe(true);
    // 此前这一条是 false：底下明明躺着两条摘录，却折不起来，读者会觉得三角有无没道理。
    expect(foldable("只有摘录")).toBe(true);
    // 真的什么都没有才不画三角——点了什么都不会发生的控件是骗人的。
    expect(foldable("空的")).toBe(false);
  });

  it("折起一个只有摘录的小节，摘录跟着藏起来", () => {
    const rows = outlineRows([group("只有摘录", 0, ["a"])], new Set([0]));

    expect(rows[0].expanded).toBe(false);
    // 行还在（存在性不能丢），数量也还在——藏起来的只是细节。
    expect(rows[0].clipCount).toBe(1);
  });

  it("「目录之前」那一组永远在最前", () => {
    const rows = outlineRows([before(["x"]), ...BOOK], new Set());
    expect(shown(rows)[0]).toBe("（之前）");
  });

  it("「目录之前」不拥有任何小节——它是收容所，不是树上的节点", () => {
    // 目录从 level 1 起头时（有些书没有「章」这一层），紧跟其后的 1.1 层级更深，
    // 但它不是「目录之前」的子孙——把它折进去，读者会发现整份目录消失了。
    const rows = outlineRows([before(["x"]), group("1.1", 1, ["a"]), group("1.2", 1)], new Set());

    // 它自己有摘录，所以能折——但**折的只是自己那几条**。
    expect(rows[0].foldable).toBe(true);
    expect(rows[0].clipCount).toBe(1);
    expect(shown(rows)).toEqual(["（之前）", "1.1", "1.2"]);
    // 折起它，后面的 1.1 / 1.2 一个都不能跟着消失——它们不是它的子孙。
    const folded = outlineRows([before(["x"]), group("1.1", 1, ["a"]), group("1.2", 1)], new Set([0]));
    expect(shown(folded)).toEqual(["（之前）", "1.1", "1.2"]);
  });

  it("层级跳级也不能漏：1 直接跳到 3，3 仍然是 1 的子孙", () => {
    const rows = outlineRows([group("第1章", 0), group("深", 3, ["a"]), group("第2章", 0)], new Set([0]));
    expect(shown(rows)).toEqual(["第1章", "第2章"]);
  });

  it("**每行带着它在 groups 里的下标**——折叠状态按它记，用行号会错位", () => {
    // 折起「第1章」之后，「第2章」在 rows 里是第 1 行，但它在 groups 里是第 4 个。
    // 拿行号去记翻转，点「第2章」会翻到「1.1」头上。
    const rows = outlineRows(BOOK, new Set([0]));

    expect(shown(rows)).toEqual(["第1章", "第2章"]);
    expect(rows.map((r) => r.index)).toEqual([0, 4]);
  });

  it("没有目录时（只有一个 null 组）照常给出那一行", () => {
    expect(shown(outlineRows([before(["a", "b"])], new Set()))).toEqual(["（之前）"]);
  });
});
