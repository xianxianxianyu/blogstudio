import { useEffect, useState } from "react";

/**
 * Panel 的那条顶栏，画在 `/write` 上面（`frontend/src/Shell.tsx` 的 `.bar`，同一排链接、
 * 同一套颜色）。**目的只有一个：让 Write 与 Robot、Projects 看起来是同一个应用**——
 * 顶上同一条栏，点 Robot 直接跳回去，Sign out 走 Panel 的登出。
 *
 * 它不是路由：Panel 的其他页在另一个包里，这里每一个链接都是整页跳转。
 *
 * 名字与令牌向 Panel 的 `/api/session` 要——同一个 host，cookie 直接带上。
 * 在 vite dev 下没有 Panel，这一问会失败：栏照样画，只是没有名字、没有 Sign out。
 * 不去猜一个假用户名，也不把失败报出来：它不是这一页的正事。
 */
export function PanelBar() {
  const [who, setWho] = useState<{ username: string; csrf: string } | null>(
    null,
  );

  useEffect(() => {
    let live = true;
    fetch("/api/session", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          session: {
            authenticated?: boolean;
            username?: string | null;
            csrf_token?: string;
          } | null,
        ) => {
          if (
            live &&
            session?.authenticated &&
            session.username &&
            session.csrf_token
          ) {
            setWho({ username: session.username, csrf: session.csrf_token });
          }
        },
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const leave = async () => {
    if (who === null) return;
    // 与 Panel 前端的 `signOut` 一字不差：POST + 它的 CSRF 头。登出后服务端已经吊销了
    // 会话，不管这一页还开着什么，回到 /login 是唯一对的去处。
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": who.csrf },
      body: "{}",
    }).catch(() => {});
    window.location.assign("/login");
  };

  return (
    <header className="panel-bar">
      {/* 没有栏，只有两枚浮在桌面上的胶囊：去哪儿、你是谁。当前项反白，不上色。 */}
      <div className="pill-group">
        <strong>Panel</strong>
        <a href="/projects">Projects</a>
        <a href="/robot">Robot 工作台</a>
        <a href="/security">Security</a>
        {/* 当前项。`aria-current` 既是样式钩子也是可访问名——Panel 那边同一个写法。 */}
        <a href="/write/" aria-current="page">
          Write
        </a>
      </div>
      <span className="spacer" />
      {who !== null && (
        <div className="pill-group">
          <span className="muted">{who.username}</span>
          <button type="button" className="link" onClick={() => void leave()}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
