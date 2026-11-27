// Explicitly launched audio output: only the last uploaded Node file and PCM
// supplied by its loopback API. No microphone capture or third-party network.
import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

func deviceUID() throws -> String {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { throw NSError(domain: "DeviceList", code: 1) }
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / 4)
    let result = devices.withUnsafeMutableBytes { AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!) }
    guard result == noErr else { throw NSError(domain: "DeviceList", code: Int(result)) }
    for id in devices {
        var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
        var value: Unmanaged<CFString>?
        var length = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        if AudioObjectGetPropertyData(id, &property, 0, nil, &length, &value) == noErr, let value {
            let uid = value.takeRetainedValue() as String
            if uid == "NodeAudioBridge_Send_UID" { return uid }
        }
    }
    throw NSError(domain: "MissingNodeAudioSend", code: 1, userInfo: [NSLocalizedDescriptionKey: "未找到新版 Node Audio Send。请运行 npm run setup:check，并按驱动升级说明处理。"])
}
func emit(_ values: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) { print(String(decoding: data, as: UTF8.self)); fflush(stdout) }
}

final class AudioOutput {
    let uid: String
    let path: String
    var player: AVAudioPlayer?
    var revision = -1
    var engine: AVAudioEngine?
    var pcmPlayer: AVAudioPlayerNode?
    var queuedFrames: Int64 = 0
    var generation = 0
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    init(uid: String, path: String) { self.uid = uid; self.path = path }
    func stop() {
        generation += 1; player?.stop(); player = nil
        pcmPlayer?.stop(); engine?.stop(); pcmPlayer = nil; engine = nil; queuedFrames = 0
    }
    func command(_ value: [String: Any]) throws {
        switch value["op"] as? String {
        case "source":
            let next = value["revision"] as? Int ?? -1
            guard next != revision else { return }
            revision = next; player?.stop(); player = nil
            guard value["kind"] as? String == "file", value["playing"] as? Bool != false else {
                emit(["event": "source", "playing": false]); return
            }
            let audio = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
            audio.currentDevice = uid; audio.numberOfLoops = value["loop"] as? Bool == false ? 0 : -1
            let seconds = max(0, (Date().timeIntervalSince1970 * 1000 - (value["startedAt"] as? Double ?? 0)) / 1000)
            if audio.duration > 0 {
                if audio.numberOfLoops == 0 && seconds >= audio.duration { return }
                audio.currentTime = seconds.truncatingRemainder(dividingBy: audio.duration)
            }
            guard audio.prepareToPlay(), audio.play() else { throw NSError(domain: "AudioPlaybackFailed", code: 1) }
            player = audio; emit(["event": "source", "playing": true, "device": "Node Audio Send"])
        case "pcm":
            guard let base64 = value["pcm"] as? String, let data = Data(base64Encoded: base64), !data.isEmpty, data.count % 8 == 0, data.count <= 192000 else { return }
            let frames = data.count / 8
            guard queuedFrames + Int64(frames) <= 48000 else { return } // one second maximum backlog
            if engine == nil {
                let output = AVAudioEngine(), node = AVAudioPlayerNode()
                guard let unit = output.outputNode.audioUnit else { throw NSError(domain: "MissingAudioUnit", code: 1) }
                // Resolve exactly this output device; never fall back to speakers.
                var selector = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslateUIDToDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
                var id: AudioDeviceID = 0, length: UInt32 = 4
                let uidString = uid as CFString
                var reference = Unmanaged.passUnretained(uidString)
                let lookup = withExtendedLifetime(uidString) {
                    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &selector, UInt32(MemoryLayout<Unmanaged<CFString>>.size), &reference, &length, &id)
                }
                guard lookup == noErr, id != 0 else { throw NSError(domain: "MissingNodeOutput", code: 1) }
                let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, 4)
                guard status == noErr else { throw NSError(domain: "SelectNodeOutput", code: Int(status)) }
                output.attach(node); output.connect(node, to: output.mainMixerNode, format: format)
                try output.start(); node.play(); engine = output; pcmPlayer = node
            }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)), let channels = buffer.floatChannelData else { return }
            buffer.frameLength = AVAudioFrameCount(frames)
            data.withUnsafeBytes { bytes in
                for frame in 0..<frames { for channel in 0..<2 {
                    let sample = bytes.loadUnaligned(fromByteOffset: (frame * 2 + channel) * 4, as: Float.self)
                    channels[channel][frame] = sample.isFinite ? max(-1, min(1, sample)) : 0
                }}
            }
            queuedFrames += Int64(frames)
            let current = generation
            pcmPlayer?.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                DispatchQueue.main.async { if let self, self.generation == current { self.queuedFrames -= Int64(frames) } }
            }
        case "stop": stop(); revision = -1
        default: break
        }
    }
}

do {
    if CommandLine.arguments.contains("--check") { emit(["deviceUID": try deviceUID(), "ready": true]); exit(0) }
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "Usage: AutoAudio uploaded-source-path", code: 1) }
    let audio = AudioOutput(uid: try deviceUID(), path: CommandLine.arguments[1])
    emit(["event": "ready", "device": "Node Audio Send"])
    let pcmSlots = DispatchSemaphore(value: 8)
    DispatchQueue.global().async {
        while let line = readLine() {
            guard line.utf8.count <= 300000, let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let pcm = value["op"] as? String == "pcm"
            if pcm && pcmSlots.wait(timeout: .now()) != .success { continue }
            DispatchQueue.main.async {
                defer { if pcm { pcmSlots.signal() } }
                do { try audio.command(value) }
                catch { emit(["event": "error", "message": "\(error)"]) }
            }
        }
        DispatchQueue.main.async { audio.stop(); exit(0) }
    }
    RunLoop.main.run()
} catch { fputs("\(error)\n", stderr); exit(1) }
