# Qwen 实时语音

按[项目配置说明](../README_CN.md#配置)填写 `DASHSCOPE_API_KEY` 和 `QWEN_REALTIME_URL`；不使用 Qwen 时同时留空。端点可用性取决于账号、模型与音色权限。客户端只连接本机媒体服务；服务端将密钥发给指定端点，不跟随重定向。

## 端点、模型与音色

- `QWEN_REALTIME_URL`：使用获授权的 `wss://` 地址，例如 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`。自定义端点须支持 PCM、语义 VAD 和会话确认；URL 不得包含用户名、密码或片段。
- `QWEN_REALTIME_MODEL`：可在此处或 URL 的 `model` 指定。两处都填必须一致；均未指定时用 `qwen3.5-omni-flash-realtime`。URL 不能重复提供 `model`。
- `QWEN_VOICE`：默认 `Raymond`，仅接受字母、数字、下划线和连字符。API Key 和模型标识也不能包含空白或控制字符。
- `QWEN_INSTRUCTIONS`：可选的服务端提示词。

## 会话与选路

服务端确认模型、音色及音频会话参数后开始传输。企微模式上传采集的应用音频和通话窗口画面；实体麦克风模式只发送音频。输出选 Node Audio Send 或 BlackHole，避免同一虚拟设备同时承担输入和输出。回复音频驱动内置数字人的口型。

一次只运行一个模型会话。连接异常、采集中断或虚拟输出消失时结束会话，不自动重连。`npm run test:qwen` 和 `npm run test:media` 使用模拟服务；实际连通性需使用自己的配置验证。
