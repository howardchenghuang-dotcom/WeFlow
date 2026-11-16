const status = document.getElementById('status');
const btn = id => document.getElementById(id);
async function refresh() {
  try {
    const data = await window.weflowBridge.status();
    status.textContent = '本地服务：' + (data.ready ? '已就绪' : '正在启动') + '\nChatGPT：' + data.session.status
      + '\n订阅共享授权：' + (data.session.sharing ? '已启用' : '未启用');
  } catch (error) { status.textContent = '状态获取失败：' + error.message; }
}
async function run(action) {
  btn('signIn').disabled = true;
  try { await action(); } catch (error) { status.textContent = '操作失败：' + error.message; }
  finally { btn('signIn').disabled = false; await refresh(); }
}
btn('signIn').onclick = () => run(() => window.weflowBridge.signIn());
btn('disconnect').onclick = () => run(() => window.weflowBridge.disconnect());
btn('usage').onclick = () => run(() => window.weflowBridge.openUsage());
window.weflowBridge.onError(message => { status.textContent = message; });
refresh();
