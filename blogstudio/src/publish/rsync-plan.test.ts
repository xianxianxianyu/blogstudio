import { describe, expect, it } from "vitest";
import { parseChanges } from "./rsync-plan";

/** 真跑 `rsync -azc --delete --dry-run --itemize-changes -8` 抓下来的输出，一个字没改。 */
const REAL = [
  "*deleting blog/云端多出来的.html",
  "*deleting blog/整个目录要删/index.html",
  "*deleting blog/整个目录要删",
  "*deleting blog/云端多出来的.html",
  "*deleting blog/整个目录要删/index.html",
  "*deleting blog/整个目录要删",
  ">f+++++++ blog/新增的-WSL2搭建cuda.html",
  ">f.s..... blog/要改的.html",
  "cd+++++++ blog/子目录/",
  ">f+++++++ blog/子目录/index.html",
].join("\n");

describe("parseChanges", () => {
  it("认得新增、改动、删除", () => {
    const out = parseChanges(REAL);
    expect(out.added).toEqual(["blog/新增的-WSL2搭建cuda.html", "blog/子目录/index.html"]);
    expect(out.changed).toEqual(["blog/要改的.html"]);
  });

  it("**`*deleting` 每条会出现两次**，只能算一次", () => {
    // openrsync 干跑时就是这么打的。不去重的话「会删掉 4 个」而其实是 2 个，
    // 而删除恰恰是这一整件事里唯一不可逆的部分。
    const out = parseChanges(REAL);
    expect(out.deleted.filter((one) => one === "blog/云端多出来的.html")).toHaveLength(1);
  });

  it("删掉一整个目录时，目录那条折叠掉，留下真正的文件", () => {
    // `整个目录要删` 和它里面的 `index.html` 各来一条。目录那条是前者的前缀，
    // 留着会让「删几个文件」这个数字翻倍。
    const out = parseChanges(REAL);
    expect(out.deleted).toEqual(["blog/云端多出来的.html", "blog/整个目录要删/index.html"]);
  });

  it("中文路径原样出来", () => {
    // 适配器必须传 `-8`。不传的话这里拿到的是 `blog/\\#226...-WSL2\\#220\\#255建cuda.html`，
    // 而这个博客的文件名**就是中文的**。
    expect(parseChanges(REAL).added[0]).toBe("blog/新增的-WSL2搭建cuda.html");
  });

  it("只对齐 mtime、内容没变的**不算改动**", () => {
    // 首字符 `.` = 不传输，只更新属性。Hugo 每次全量重建都会刷新所有 mtime，
    // 算进去的话每次部署都显示「几百个文件改动」，然后人就不看了。
    expect(parseChanges(".f..t.... 一样的.html").changed).toEqual([]);
    expect(parseChanges(".d..t..g. ./").changed).toEqual([]);
  });

  it("内容真的变了才算改动（`-c` 认出来的那种）", () => {
    expect(parseChanges(">fcst.... 一样的.html").changed).toEqual(["一样的.html"]);
  });

  it("目录不是文件，一律不算", () => {
    const out = parseChanges("cd+++++++ blog/子目录/\n.d..t.... ./");
    expect(out.added).toEqual([]);
    expect(out.changed).toEqual([]);
  });

  it("什么都不用同步时给三个空数组，不抛", () => {
    // 「这次没什么可传的」是正常状态，不是错误。
    expect(parseChanges("")).toEqual({ added: [], changed: [], deleted: [] });
    expect(parseChanges("\n\n")).toEqual({ added: [], changed: [], deleted: [] });
  });

  it("看不懂的行直接跳过，不让它污染任何一档", () => {
    // rsync 偶尔会夹带别的话（`sending incremental file list`、统计行）。
    const out = parseChanges("sending incremental file list\n>f+++++++ a.html\n\nsent 1 bytes");
    expect(out.added).toEqual(["a.html"]);
    expect(out.changed).toEqual([]);
    expect(out.deleted).toEqual([]);
  });

  it("只认 rsync 真的会输出的类型位", () => {
    // 符号链接（`L`）算数；而形状像、类型位却对不上的行不算——放宽成「任意字符」的话，
    // 别的工具夹带的一行只要长得像，就会被算成一个文件。
    expect(parseChanges(">L+++++++ a -> b").added).toEqual(["a -> b"]);
    expect(parseChanges(">z+++++++ 不该被认出来").added).toEqual([]);
  });

  it("路径里有空格也完整", () => {
    expect(parseChanges(">f+++++++ blog/a b c.html").added).toEqual(["blog/a b c.html"]);
    expect(parseChanges("*deleting blog/x y.html").deleted).toEqual(["blog/x y.html"]);
  });
});
