import Foundation
import AVFoundation
import CoreAudio
import ScreenCaptureKit
import CoreMedia
import CoreImage
import AudioToolbox
import Darwin

struct CaptureError: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}
// Each media type has at most one HTTP upload in flight. Slow consumers drop
// frames instead of accumulating unbounded call media or increasing latency.
final class Uploader: @unchecked Sendable {
    let endpoint: URL, token: String
    private let lock = NSLock()
    private var busy = Set<String>()
    init(_ endpoint: URL, _ token: String) { self.endpoint = endpoint; self.token = token }
    func send(_ data: Data, path: String, contentType: String) {
        lock.lock()
        guard !busy.contains(path) else { lock.unlock(); return }
        busy.insert(path); lock.unlock()
        var request = URLRequest(url: URL(string: path, relativeTo: endpoint)!)
        request.httpMethod = "POST"; request.httpBody = data; request.timeoutInterval = 2
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            self?.lock.lock(); self?.busy.remove(path); self?.lock.unlock()
        }.resume()
    }
}
final class Receiver: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let uploader: Uploader
    let context = CIContext(options: [.cacheIntermediates: false])
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    var videoFrames = 0, audioPackets = 0, warned = false
    init(_ uploader: Uploader) { self.uploader = uploader }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("采集停止：\(error.localizedDescription)\n", stderr); exit(1)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard buffer.isValid else { return }
        if type == .screen {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue: raw) == .complete,
                  let image = CMSampleBufferGetImageBuffer(buffer) else { return }
            let ci = CIImage(cvPixelBuffer: image)
            guard let data = context.jpegRepresentation(of: ci, colorSpace: colorSpace, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7]) else { return }
            uploader.send(data, path: "bridge/ingest/frame/incoming", contentType: "image/jpeg")
            videoFrames += 1
        } else if type == .audio {
            do {
                let data = try pcm(buffer)
                if !data.isEmpty { uploader.send(data, path: "bridge/ingest/pcm/incoming", contentType: "application/octet-stream"); audioPackets += 1 }
            } catch { if !warned { fputs("音频格式：\(error)\n", stderr); warned = true } }
        }
    }
    // ScreenCaptureKit is configured for 48kHz stereo. Preserve Float32 samples,
    // interleaving planar buffers; reject unexpected formats instead of noise.
    func pcm(_ sample: CMSampleBuffer) throws -> Data {
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return Data() }
        guard basic.mFormatID == kAudioFormatLinearPCM, basic.mSampleRate == 48000,
              basic.mChannelsPerFrame == 2, basic.mBitsPerChannel == 32,
              basic.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              basic.mFormatFlags & kAudioFormatFlagIsBigEndian == 0 else { throw CaptureError("需要 48kHz 双声道 Float32 PCM") }
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed >= MemoryLayout<AudioBufferList>.size else { return Data() }
        let memory = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        let list = memory.bindMemory(to: AudioBufferList.self, capacity: 1)
        var retained: CMBlockBuffer?
        let code = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: needed, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &retained)
        guard code == noErr else { throw CaptureError("无法读取音频缓冲：\(code)") }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        return try withExtendedLifetime(retained) {
            if basic.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 {
                guard let first = buffers.first, let bytes = first.mData, first.mNumberChannels == 2 else { return Data() }
                return Data(bytes: bytes, count: Int(first.mDataByteSize))
            }
            guard buffers.count == 2, let left = buffers[0].mData, let right = buffers[1].mData else { throw CaptureError("平面声道数量异常") }
            let count = min(Int(buffers[0].mDataByteSize), Int(buffers[1].mDataByteSize)) / 4
            let l = left.assumingMemoryBound(to: Float.self), r = right.assumingMemoryBound(to: Float.self)
            var output = [Float](repeating: 0, count: count * 2)
            for i in 0..<count { output[i * 2] = l[i]; output[i * 2 + 1] = r[i] }
            return output.withUnsafeBytes { Data($0) }
        }
    }
}
final class InputRecording: @unchecked Sendable {
    let engine = AVAudioEngine()
    func start(name: String, uploader: Uploader, id: String) throws {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
        var size: UInt32 = 0
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / 4)
        let status = devices.withUnsafeMutableBytes { AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!) }
        guard status == noErr, var device = devices.first(where: { device in
            var prop = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
            var label: Unmanaged<CFString>?, length = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(device, &prop, 0, nil, &length, &label) == noErr, let label else { return false }
            return label.takeRetainedValue() as String == name
        }) else { throw CaptureError("企微输入设备已不可用") }
        let node = engine.inputNode
        guard let unit = node.audioUnit else { throw CaptureError("输入设备无音频单元") }
        let selected = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard selected == noErr else { throw CaptureError("无法采集企微输入设备：\(selected)") }
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false),
              let converter = AVAudioConverter(from: format, to: output) else { throw CaptureError("输入音频格式不支持") }
        node.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 48000 / format.sampleRate) + 256)
            guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
            var supplied = false, error: NSError?
            converter.convert(to: converted, error: &error) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true; state.pointee = .haveData; return buffer
            }
            guard error == nil, let channels = converted.floatChannelData, converted.frameLength > 0 else { return }
            var samples = [Float](repeating: 0, count: Int(converted.frameLength) * 2)
            for i in 0..<Int(converted.frameLength) { samples[i * 2] = channels[0][i]; samples[i * 2 + 1] = channels[1][i] }
            uploader.send(samples.withUnsafeBytes { Data($0) }, path: "bridge/ingest/recording/input?id=\(id)", contentType: "application/octet-stream")
        }
        try engine.start()
    }
}

@main struct Main {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args == ["--help"] { print("WeComCapture --list | --capture WINDOW_ID http://127.0.0.1:PORT（令牌从 stdin 读取）"); return }
            if args.first == "--record-input" {
                guard args.count == 4, let endpoint = URL(string: args[1]), endpoint.scheme == "http", endpoint.host == "127.0.0.1",
                      let token = readLine(), token.count == 64 else { throw CaptureError("录音参数错误") }
                let allowed = await AVCaptureDevice.requestAccess(for: .audio)
                guard allowed else { throw CaptureError("请在系统设置允许采集组件访问麦克风，然后重新接通通话") }
                let recording = InputRecording()
                try recording.start(name: args[2], uploader: Uploader(endpoint, token), id: args[3])
                let parent = getppid()
                while getppid() == parent { try await Task.sleep(for: .seconds(1)); _ = recording }
                return
            }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let windows = content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.tencent.WeWorkMac" && $0.frame.width > 100 && $0.frame.height > 100 }
            if args == ["--list"] {
                let values = windows.map { ["id": $0.windowID, "title": $0.title ?? "企微窗口", "width": Int($0.frame.width), "height": Int($0.frame.height)] as [String: Any] }
                let data = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self)); return
            }
            guard args.count == 3, args[0] == "--capture", let id = UInt32(args[1]),
                  let endpoint = URL(string: args[2]), endpoint.scheme == "http", endpoint.host == "127.0.0.1",
                  let token = readLine(), token.count == 64 else { throw CaptureError("参数错误或缺少本地服务令牌") }
            guard let window = windows.first(where: { $0.windowID == id }), let app = window.owningApplication,
                  let display = content.displays.first else { throw CaptureError("选中的企微窗口已关闭，请重新读取列表") }
            let receiver = Receiver(Uploader(endpoint, token))
            let video = SCStreamConfiguration()
            let scale = min(1, 1280 / max(window.frame.width, window.frame.height))
            video.width = max(2, Int(window.frame.width * scale) / 2 * 2)
            video.height = max(2, Int(window.frame.height * scale) / 2 * 2)
            video.minimumFrameInterval = CMTime(value: 1, timescale: 15)
            video.queueDepth = 3; video.showsCursor = false; video.capturesAudio = false
            let screenStream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: video, delegate: receiver)
            try screenStream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "wecom.video"))
            let audio = SCStreamConfiguration()
            audio.width = 2; audio.height = 2; audio.capturesAudio = true
            audio.sampleRate = 48000; audio.channelCount = 2; audio.excludesCurrentProcessAudio = true
            // Separate app-scoped audio stream. The web service never receives
            // other applications' audio or the unselected WeCom windows.
            let audioStream = SCStream(filter: SCContentFilter(display: display, including: [app], exceptingWindows: []), configuration: audio, delegate: receiver)
            try audioStream.addStreamOutput(receiver, type: .audio, sampleHandlerQueue: DispatchQueue(label: "wecom.audio"))
            try await screenStream.startCapture()
            do { try await audioStream.startCapture() } catch { try? await screenStream.stopCapture(); throw error }
            print("CAPTURE_READY"); fflush(stdout)
            // The parent terminates this child on stop, server shutdown or window
            // closure; streams and in-flight HTTP uploads then close with it.
            let parent = getppid()
            var tick = 0
            while true {
                try await Task.sleep(for: .seconds(1))
                if getppid() != parent { exit(0) }
                tick += 1
                if tick % 3 == 0 {
                    let active = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                    if !active.windows.contains(where: { $0.windowID == id && $0.owningApplication?.bundleIdentifier == "com.tencent.WeWorkMac" }) {
                        try? await screenStream.stopCapture(); try? await audioStream.stopCapture()
                        print("CAPTURE_WINDOW_CLOSED"); return
                    }
                }
                print("CAPTURE_HEARTBEAT"); fflush(stdout)
                _ = receiver; _ = screenStream; _ = audioStream
            }
        } catch { fputs("\(error.localizedDescription)\n需要在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许启动本服务的终端或采集组件；授权后重启服务。\n", stderr); exit(1) }
    }
}
