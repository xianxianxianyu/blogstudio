/**
 * 一句话状态，给「正在做一件慢事」用。
 *
 * 存在的理由很具体：首次提问要下载几百 MB 的本地向量模型、再给整篇论文算向量，
 * 可能几分钟。这期间界面上原本什么都没有——**跟卡死没有区别**，读者只会以为坏了。
 * 和当初把 cause 链打出来是同一件事：把看不见的变成看得见。
 */
export interface Progress {
  readonly text: string | null;
  subscribe(listener: () => void): () => void;
  set(text: string | null): void;
}

export function createProgress(): Progress {
  let text: string | null = null;
  const listeners = new Set<() => void>();

  return {
    get text() {
      return text;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: string | null): void {
      // 同一句话不重复通知：下载回调每几十 KB 就触发一次，不去重的话每秒几百次重渲染。
      if (next === text) return;
      text = next;
      for (const listener of listeners) listener();
    },
  };
}
