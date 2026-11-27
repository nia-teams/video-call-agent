# Node Audio Bridge

独立构建和安装的 macOS 虚拟音频驱动，基于 Existential Audio Inc. 的 [BlackHole](https://github.com/ExistentialAudio/BlackHole)。本目录仅以源码分发，采用 [GPL-3.0](vendor/LICENSE)，不属于应用的 MIT 许可范围。应用通过 CoreAudio 设备与驱动通信。Node Audio Bridge 与 Existential Audio 无隶属关系，也未获其背书。

- **Node Audio Send**：双声道输出，接收网页播放器或 PCM API 的声音。
- **Node Virtual Mic**：双声道输入，供企业微信或其他应用选择为麦克风。

两个单向设备共享内存环形缓冲，默认 48 kHz。

## 构建

在项目根目录运行 `npm run driver:build`。构建生成 `media/native/.build/NodeAudioBridge.driver`，包含 arm64 和 x86_64，并使用本机 ad-hoc 签名。`check.c` 可在普通进程中验证设备方向、UID、环形缓冲传输及静音。

## 安装

结束通话和录音后运行 `npm run driver:install`，按提示授予管理员权限。安装程序将驱动放到 `/Library/Audio/Plug-Ins/HAL/NodeAudioBridge.driver`，并重启 CoreAudio。`install.sh` 不覆盖现有驱动；重装前先按下节移出已有的 `NodeAudioBridge.driver`。已安装的 BlackHole 驱动不受影响。

在浏览器刷新设备列表，将播放输出选为 **Node Audio Send**；在 macOS 和企微将麦克风选为 **Node Virtual Mic**。运行 `npm run setup:check` 并在测试通话中确认对端能听到声音。

## 卸载与回退

切回实体麦克风，停止发送音频并执行 `npm stop`。以管理员身份将 `NodeAudioBridge.driver` 移出 HAL 目录（例如备份为 `/Library/Audio/Plug-Ins/NodeAudioBridge.driver.disabled`），然后重启 CoreAudio 或 Mac。回退时，将备份的驱动恢复到 HAL 目录，使用与该驱动匹配的应用版本，再重启音频服务并重新选择设备。
