/** Stream progress while the native helper warms up Vision on a new Mac. */
export function createCameraSelection({ launch, output, error, timeoutMs = 60000 }) {
  let active = null;
  function cancel() {
    if (!active) return;
    const current = active; active = null; current.cancelled = true;
    clearTimeout(current.timer); current.process.kill('SIGTERM');
  }
  return {
    cancel,
    start(args) {
      cancel();
      const process = launch(args);
      const current = { process, cancelled: false, timedOut: false, timer: null };
      active = current;
      const finish = () => { clearTimeout(current.timer); if (active === current) active = null; };
      process.stdout?.on('data', data => output(data, false));
      process.stderr?.on('data', data => output(data, true));
      process.once('error', () => { finish(); if (!current.cancelled) error('新版摄像头辅助程序无法启动，请检查原生组件。'); });
      process.once('exit', (code, signal) => {
        finish();
        if (code !== 0 && !current.cancelled && !current.timedOut) error(`新版摄像头选择未完成（${signal || code}），请查看前面的阶段日志。`);
      });
      current.timer = setTimeout(() => {
        current.timedOut = true;
        error(`新版摄像头选择超时（${timeoutMs / 1000} 秒），已停止；请查看最后一条阶段日志。`);
        process.kill('SIGTERM');
      }, timeoutMs);
    },
  };
}
