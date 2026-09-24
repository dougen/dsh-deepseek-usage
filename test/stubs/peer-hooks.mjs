// dsh-deepseek-usage — 宿主测试用 peer 依赖替身（本仓库没有 node_modules）。
//
// lib/index.js 只依赖一个宿主包 @deepseek-ai/dsh-credentials（credentialRef）。
// 测试里用 registerHooks 把它换成下面的 stub，从而在没有 DSH 安装的仓库里也能
// 完整跑通宿主逻辑。同时把 `?graph=<tag>` 沿相对导入链传下去：带上 tag 的入口
// 会让 lib/ 下每个模块都拿到独立实例，用来模拟"进程重启"（内存态全部清零）。
import { registerHooks } from "node:module";

const CREDENTIALS_STUB = new URL("./dsh-credentials-stub.mjs", import.meta.url).href;

/** 从 URL 里取出 `graph` 标签（没有则 null）。 */
function graphTag(url) {
  if (typeof url !== "string") return null;
  const m = /[?&]graph=([\w.-]+)/.exec(url);
  return m ? m[1] : null;
}

/** 安装一次即可（重复调用无副作用）。 */
export function installPeerStubs() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@deepseek-ai/dsh-credentials") {
        return { url: CREDENTIALS_STUB, shortCircuit: true };
      }
      const resolved = nextResolve(specifier, context);
      const tag = graphTag(context.parentURL);
      if (tag && resolved.url.startsWith("file:") && resolved.url.includes("/lib/") && !resolved.url.includes("?")) {
        return { ...resolved, url: `${resolved.url}?graph=${tag}` };
      }
      return resolved;
    },
  });
}
