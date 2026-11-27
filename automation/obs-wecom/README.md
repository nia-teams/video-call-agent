# OBS 与企微通话自动化

按[新 Mac 清单](../../docs/NEW_MAC_SETUP.md)完成权限和设备准备，再从项目根目录执行 `npm start`。`npm run start:check` 检查设备、辅助功能和 OBS 连接；`npm stop` 停止启动器及它启动的组件，保留 OBS 和企微。

## 通话生命周期

- **接听**：`CameraSwitch` 通过 macOS 辅助功能定位一对一来电。只有窗口和接听控件能唯一确认时才操作，点击前重新核验，每个窗口只尝试一次。会议和多个候选窗口跳过。设置 `STUDIO_AUTO_ANSWER=0` 可关闭；独立启动 `CameraSwitch` 时需显式传入 `--auto-answer`。
- **采集**：接通后自动选择可唯一确认的通话窗口，采集就绪后连接控制台选定的模型（默认 Qwen）。手动接听也可触发自动采集；设置 `STUDIO_AUTO_CAPTURE=0` 改为手动采集和连接。挂断只释放本次自动流程持有的采集，保留手动选择的其他窗口。
- **设备**：启动器按 UID 设置虚拟麦克风并为已识别的视频通话选择 `OBS Virtual Camera`。窗口、按钮或权限不明确时保留手动操作入口。详见[摄像头定位](CAMERA_COMPATIBILITY.md)。

## OBS 启动

启动器复用或启动本机媒体服务，再打开 Chrome。OBS 未运行时，会备份原 WebSocket 配置并按项目设置开启密码认证；已运行时使用现有配置。通过本机 WebSocket 适配 1080×1920 画布、复用或创建浏览器源并启动虚拟摄像头。浏览器源默认指向 <http://127.0.0.1:3070/studio/output>；场景中其他来源会保留。

OBS 准备失败时，通话监控和音频仍可运行；检查 `.runtime/media-studio/one-click.log` 和 OBS 预览后再验收视频链路。
