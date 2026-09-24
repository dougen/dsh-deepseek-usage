// dsh-deepseek-usage — @deepseek-ai/dsh-credentials 的最小替身。
// 宿主只用到 credentialRef(name)：返回一个交给 ctx.credentials.resolve() 的引用，
// 测试里 resolve 由假 ctx 实现，因此这里只要形状足够即可。
export function credentialRef(name) {
  return { name, stub: true };
}

export default { credentialRef };
