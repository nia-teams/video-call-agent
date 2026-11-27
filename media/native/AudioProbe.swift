import Foundation
import CoreAudio

func ids(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var result = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    let status = result.withUnsafeMutableBytes { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!) }
    return status == noErr ? result : []
}
func text(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return "" }
    return value.takeRetainedValue() as String
}
func names(_ values: [AudioObjectID]) -> [String] { values.map { text($0, kAudioObjectPropertyName) } }
func controls(_ object:AudioObjectID, _ scope:AudioObjectPropertyScope) -> [[String:Any]] {
    (0...2).map { channel in
        var result:[String:Any] = ["channel":channel]
        var volume = Float32(0), size = UInt32(MemoryLayout<Float32>.size)
        var address = AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyVolumeScalar,mScope:scope,mElement:UInt32(channel))
        if AudioObjectGetPropertyData(object,&address,0,nil,&size,&volume) == noErr {result["volume"]=volume}
        var mute:UInt32=0;size=UInt32(MemoryLayout<UInt32>.size);address.mSelector=kAudioDevicePropertyMute
        if AudioObjectGetPropertyData(object,&address,0,nil,&size,&mute) == noErr {result["mute"]=mute}
        return result
    }
}
let system = AudioObjectID(kAudioObjectSystemObject)
let args = Array(CommandLine.arguments.dropFirst())
let nodeSendUID = "NodeAudioBridge_Send_UID"
let nodeMicUID = "NodeAudioBridge_Mic_UID"
func deviceUID(_ device: AudioObjectID) -> String { text(device, kAudioDevicePropertyDeviceUID) }
if args.contains("--normalize-blackhole") {
    guard let device=ids(system,kAudioHardwarePropertyDevices).first(where:{text($0,kAudioObjectPropertyName)=="BlackHole 2ch"}) else {exit(1)}
    for scope in [kAudioObjectPropertyScopeInput,kAudioObjectPropertyScopeOutput] {
        var address=AudioObjectPropertyAddress(mSelector:kAudioDevicePropertyVolumeScalar,mScope:scope,mElement:kAudioObjectPropertyElementMain)
        var volume:Float32=1
        let status=AudioObjectSetPropertyData(device,&address,0,nil,UInt32(MemoryLayout<Float32>.size),&volume)
        guard status==noErr else {fputs("设置 BlackHole 音量失败：\(status)\n",stderr);exit(1)}
        address.mSelector=kAudioDevicePropertyMute;var mute:UInt32=0
        _=AudioObjectSetPropertyData(device,&address,0,nil,UInt32(MemoryLayout<UInt32>.size),&mute)
    }
}
if args.contains("--select-blackhole") || args.contains("--restore-microphone") || args.contains("--prepare-virtual") || args.contains("--select-node-mic") {
    let all = ids(system, kAudioHardwarePropertyDevices)
    let nodeMic = all.first { deviceUID($0) == nodeMicUID }
    let restore = args.contains("--restore-microphone")
    let selectNode = !restore && (args.contains("--select-node-mic") || (args.contains("--prepare-virtual") && nodeMic != nil))
    let name = restore ? "MacBook Pro麦克风" : selectNode ? "Node Virtual Mic" : "BlackHole 2ch"
    guard var selected = selectNode ? nodeMic : all.first(where: { text($0, kAudioObjectPropertyName) == name }) else {
        if selectNode { fputs("未找到新版 Node Virtual Mic。请运行 npm run setup:check，并按驱动升级说明处理。\n", stderr) }
        else { fputs("找不到音频输入：\(name)\n", stderr) }
        exit(1)
    }
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectSetPropertyData(system, &address, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &selected)
    guard status == noErr else { fputs("切换输入失败：\(status)\n", stderr); exit(1) }
}
// Keep application playback out of the virtual send bus. Preserve any physical
// speaker/headphone output the user already selected.
if args.contains("--repair-output") {
    let all = ids(system, kAudioHardwarePropertyDevices)
    for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice] {
        guard let current = ids(system, selector).first else { continue }
        let name = text(current, kAudioObjectPropertyName)
        guard name.contains("Node Audio Send") || name.contains("BlackHole") else { continue }
        guard var speaker = all.first(where: { id in
            var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
            var transport: UInt32 = 0, size: UInt32 = 4
            return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &transport) == noErr && transport == kAudioDeviceTransportTypeBuiltIn && !ids(id, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput).isEmpty
        }) else { fputs("找不到实体扬声器，请在系统设置选择耳机或扬声器。\n", stderr); exit(1) }
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
        let code = AudioObjectSetPropertyData(system, &address, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &speaker)
        guard code == noErr else { fputs("恢复实体输出失败：\(code)\n", stderr); exit(1) }
    }
}
// Remove only the unused experimental device created during this task.
if args.contains("--remove-experimental-bridge") {
    if let object = ids(system, kAudioHardwarePropertyDevices).first(where: { text($0, kAudioDevicePropertyDeviceUID) == "com.nia-teams.video-call-agent.duplex" }) {
        guard !ids(system, kAudioHardwarePropertyDefaultInputDevice).contains(object) else { fputs("该设备仍为默认输入，请先选择 BlackHole。\n", stderr); exit(1) }
        let status = AudioHardwareDestroyAggregateDevice(object)
        guard status == noErr else { fputs("移除测试设备失败：\(status)\n", stderr); exit(1) }
    }
}
let devices = ids(system, kAudioHardwarePropertyDevices)
let defaultInput = ids(system, kAudioHardwarePropertyDefaultInputDevice)
var result: [String: Any] = [
    "defaultInput": names(defaultInput),
    "defaultOutput": names(ids(system, kAudioHardwarePropertyDefaultOutputDevice)),
    "nodeMicInstalled": devices.contains { deviceUID($0) == nodeMicUID },
    "nodeSendInstalled": devices.contains { deviceUID($0) == nodeSendUID },
    "nodeMicSelected": defaultInput.contains { deviceUID($0) == nodeMicUID }
]
if let device = devices.first(where:{text($0,kAudioObjectPropertyName)=="BlackHole 2ch"}) {
    result["blackHoleControls"] = ["input":controls(device,kAudioObjectPropertyScopeInput),"output":controls(device,kAudioObjectPropertyScopeOutput)]
}
result["nodeControls"] = devices.filter { [nodeSendUID, nodeMicUID].contains(deviceUID($0)) }.map { device in
    ["name": text(device,kAudioObjectPropertyName), "input": controls(device,kAudioObjectPropertyScopeInput), "output": controls(device,kAudioObjectPropertyScopeOutput)] as [String: Any]
}
if #available(macOS 14.2, *) {
    result["processes"] = ids(system, kAudioHardwarePropertyProcessObjectList).compactMap { object -> [String: Any]? in
        let bundle = text(object, kAudioProcessPropertyBundleID)
        guard bundle.hasPrefix("com.tencent.WeWorkMac") || bundle.hasPrefix("com.google.Chrome") else { return nil }
        return ["bundle": bundle, "input": names(ids(object, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput).filter { !ids($0, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput).isEmpty }), "output": names(ids(object, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeOutput).filter { !ids($0, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput).isEmpty }), "inputActive": ids(object, kAudioProcessPropertyIsRunningInput).first == 1]
    }
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
