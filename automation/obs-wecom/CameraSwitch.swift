import AppKit
import ApplicationServices
import Foundation
import Darwin
import Vision

// AXPress on verified controls only. --auto-answer is explicitly enabled by the platform.
// Never dial, hang up, use fixed-coordinate clicks, or access chat/credentials.
struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func string(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}
func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    attribute(element, name) as? [AXUIElement] ?? []
}
func tree(_ root: AXUIElement, depth: Int = 8) -> [AXUIElement] {
    var result: [AXUIElement] = [], queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = Set<CFHashCode>()
    while !queue.isEmpty && result.count < 1200 {
        let (node, level) = queue.removeFirst()
        guard visited.insert(CFHash(node)).inserted else { continue }
        result.append(node)
        if level < depth { queue += elements(node, "AXChildren").map { ($0, level + 1) } }
    }
    return result
}
func label(_ element: AXUIElement) -> String {
    ["AXTitle", "AXDescription", "AXHelp", "AXValue"].map { string(element, $0) }.joined(separator: " ")
}
func press(_ element: AXUIElement) throws {
    guard (attribute(element, "AXEnabled") as? Bool) != false else { throw Failure("目标控件不可用。") }
    let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
    // cannotComplete can mean the action opened a modal/menu before returning.
    guard status == .success || status == .cannotComplete else {
        throw Failure("辅助功能操作失败（\(status.rawValue)），没有改用坐标点击。")
    }
}
func application(_ bundle: String) -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first
}
func root(_ app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 1)
    return element
}
func launch(_ path: String) throws {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = ["-g", path]
    try task.run(); task.waitUntilExit()
    guard task.terminationStatus == 0 else { throw Failure("无法启动：\(path)") }
}
func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let ax = unsafeBitCast(raw, to: AXValue.self)
    var value = CGPoint.zero
    guard AXValueGetType(ax) == .cgPoint, AXValueGetValue(ax, .cgPoint, &value) else { return nil }
    return value
}
func frame(_ element: AXUIElement) -> CGRect? {
    guard let origin = point(element, "AXPosition"),
          let raw = attribute(element, "AXSize"), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let ax = unsafeBitCast(raw, to: AXValue.self)
    var size = CGSize.zero
    guard AXValueGetType(ax) == .cgSize, AXValueGetValue(ax, .cgSize, &size) else { return nil }
    return CGRect(origin: origin, size: size)
}
func isTimer(_ title: String) -> Bool {
    title.range(of: #"^\d{1,3}:\d{2}(:\d{2})?$"#, options: .regularExpression) != nil
}
func isCall(_ window: AXUIElement) -> Bool {
    guard isTimer(string(window, "AXTitle")) else { return false }
    let controls = tree(window, depth: 3).map(label)
    return controls.contains { $0.contains("挂断") || $0.contains("End call") }
        && controls.contains { $0.contains("转语音通话") || $0.contains("Switch to voice") || $0.contains("转视频通话") || $0.contains("Switch to video") }
}
func isIncomingLabels(_ labels: [String], answerCount: Int, declineCount: Int) -> Bool {
    let text = labels.joined(separator: " ").lowercased()
    if ["会议", "meeting", "conference"].contains(where: { text.contains($0) }) { return false }
    let invitation = ["邀请你", "邀请您", "来电", "incoming", "is calling", "invites you"].contains { text.contains($0) }
    let media = ["视频", "语音", "通话", "video", "voice", "call"].contains { text.contains($0) }
    return answerCount == 1 && declineCount >= 1 && invitation && media
}
func matchesControl(_ node: AXUIElement, _ names: Set<String>) -> Bool {
    guard string(node, "AXRole") == "AXButton", (attribute(node, "AXEnabled") as? Bool) != false else { return false }
    return ["AXTitle", "AXDescription", "AXHelp"].contains { names.contains(string(node, $0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
}
// Verified WeCom 4.1.31 incoming panel: icon-only buttons expose identifiers,
// but no title/help/description. Match the entire panel before AXPress.
func matchesIncomingIconLayout(_ bounds: CGRect, _ answer: CGRect, _ decline: CGRect, _ mode: CGRect) -> Bool {
    func near(_ actual: CGRect, _ expected: CGRect) -> Bool {
        abs(actual.minX - bounds.minX - expected.minX) <= 4 && abs(actual.minY - bounds.minY - expected.minY) <= 4
            && abs(actual.width - expected.width) <= 4 && abs(actual.height - expected.height) <= 4
    }
    return abs(bounds.width - 296) <= 4 && abs(bounds.height - 136) <= 4
        && near(answer, CGRect(x: 241, y: 88, width: 38, height: 38))
        && near(decline, CGRect(x: 183, y: 88, width: 38, height: 38))
        && near(mode, CGRect(x: 15, y: 93, width: 106, height: 28))
}
// WeCom 5.0.13 / macOS 14: labels and identifiers are absent on icon buttons.
// Observed via AX diagnostics; right-hand answer / left decline confirmed by
// the user. Geometry identifies AX elements only; the action is still AXPress.
func matchesIncomingIconLayoutV5(_ bounds: CGRect, _ answer: CGRect, _ decline: CGRect, _ mode: CGRect) -> Bool {
    func near(_ actual: CGRect, _ expected: CGRect) -> Bool {
        abs(actual.minX - bounds.minX - expected.minX) <= 3 && abs(actual.minY - bounds.minY - expected.minY) <= 3
            && abs(actual.width - expected.width) <= 3 && abs(actual.height - expected.height) <= 3
    }
    return abs(bounds.width - 316) <= 3 && abs(bounds.height - 157) <= 3
        && near(answer, CGRect(x: 248, y: 97, width: 48, height: 48))
        && near(decline, CGRect(x: 176, y: 97, width: 48, height: 48))
        && near(mode, CGRect(x: 20, y: 104, width: 126, height: 33))
}
func incomingAnswer(_ window: AXUIElement) -> AXUIElement? {
    guard !isCall(window) else { return nil }
    let nodes = tree(window, depth: 6)
    let answers = nodes.filter { matchesControl($0, ["接听", "接受", "接听通话", "接听视频", "接听语音", "answer", "accept", "answer call", "accept call"]) }
    let declines = nodes.filter { matchesControl($0, ["拒绝", "拒绝通话", "挂断", "decline", "reject", "decline call", "end call"]) }
    if isIncomingLabels(nodes.map(label), answerCount: answers.count, declineCount: declines.count) { return answers.first }
    guard let bounds = frame(window) else { return nil }
    let buttons = nodes.filter { string($0, "AXRole") == "AXButton" && (attribute($0, "AXEnabled") as? Bool) != false }
    if buttons.count == 3 && isIncomingLabels(nodes.map(label), answerCount: 1, declineCount: 1) {
        for answer in buttons {
            for decline in buttons where !CFEqual(answer, decline) {
                guard let mode = buttons.first(where: { !CFEqual($0, answer) && !CFEqual($0, decline) }),
                      let answerBounds = frame(answer), let declineBounds = frame(decline), let modeBounds = frame(mode) else { continue }
                if matchesIncomingIconLayoutV5(bounds, answerBounds, declineBounds, modeBounds) { return answer }
            }
        }
    }
    guard string(window, "AXTitle") == "来电" else { return nil }
    guard buttons.count == 3,
          let answer = buttons.first(where: { string($0, "AXIdentifier") == "_NS:8" }),
          let decline = buttons.first(where: { string($0, "AXIdentifier") == "_NS:86" }),
          let mode = buttons.first(where: { string($0, "AXIdentifier") == "_NS:48" }),
          let answerBounds = frame(answer), let declineBounds = frame(decline), let modeBounds = frame(mode),
          matchesIncomingIconLayout(bounds, answerBounds, declineBounds, modeBounds),
          isIncomingLabels(nodes.map(label), answerCount: 1, declineCount: 1) else { return nil }
    return answer
}
// Opt-in, read-only diagnostics: no contact names, message text or raw AX values.
func incomingDiagnostics() -> [[String: Any]] {
    guard let app = application("com.tencent.WeWorkMac") else { return [] }
    let appRoot = root(app)
    var windowValue: CFTypeRef?
    let windowError = AXUIElementCopyAttributeValue(appRoot, "AXWindows" as CFString, &windowValue)
    let appWindows = windowValue as? [AXUIElement] ?? []
    if appWindows.isEmpty { return [["windowCount": 0, "windowError": windowError.rawValue, "pid": app.processIdentifier, "activationPolicy": app.activationPolicy.rawValue]] }
    let safeLabels: Set<String> = ["接听", "接受", "接听通话", "接听视频", "接听语音", "拒绝", "拒绝通话", "挂断", "answer", "accept", "answer call", "accept call", "decline", "reject", "decline call", "end call"]
    return appWindows.map { window in
        let nodes = tree(window, depth: 6)
        let text = nodes.map(label).joined(separator: " ").lowercased()
        let bounds = frame(window) ?? .zero
        let controls: [[String: Any]] = nodes.filter { string($0, "AXRole") == "AXButton" }.map { node in
            let rect = frame(node) ?? .zero
            let identifier = string(node, "AXIdentifier")
            let labels = ["AXTitle", "AXDescription", "AXHelp"].map { string(node, $0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { safeLabels.contains($0) }
            return ["id": identifier.range(of: #"^[A-Za-z0-9_:.-]{1,80}$"#, options: .regularExpression) != nil ? identifier : "redacted", "labels": labels, "enabled": (attribute(node, "AXEnabled") as? Bool) != false, "x": rect.minX - bounds.minX, "y": rect.minY - bounds.minY, "width": rect.width, "height": rect.height]
        }
        return ["incomingTitle": string(window, "AXTitle") == "来电", "timerTitle": isTimer(string(window, "AXTitle")), "width": bounds.width, "height": bounds.height, "invitation": ["邀请你", "邀请您", "来电", "incoming", "is calling", "invites you"].contains { text.contains($0) }, "media": ["视频", "语音", "通话", "video", "voice", "call"].contains { text.contains($0) }, "matched": incomingAnswer(window) != nil, "buttons": controls]
    }
}
func emitCallEvent(_ event: String, id: String = "", window: AXUIElement? = nil) {
    var value: [String: Any] = ["event": event, "id": id]
    if let window, let number = attribute(window, "AXWindowNumber") as? NSNumber { value["windowID"] = number.uint32Value }
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { print(String(decoding: data, as: UTF8.self)); fflush(stdout) }
}
func inCameraArea(_ button: CGRect, _ window: CGRect) -> Bool {
    guard window.width > 200, window.height > 200, button.width > 0, button.height > 0 else { return false }
    let x = (button.midX - window.minX) / window.width
    let y = button.midY - window.minY
    return x > 0.60 && x < 0.95 && y >= 0 && y < min(100, window.height * 0.15)
}
func cameraButton(_ window: AXUIElement, verifiedWindow: Bool = false) throws -> AXUIElement {
    guard isCall(window) || verifiedWindow, let bounds = frame(window) else { throw Failure("没有可识别的一对一视频通话窗口。") }
    let candidates = tree(window, depth: 3).filter { node in
        guard string(node, "AXRole") == "AXButton", let rect = frame(node), inCameraArea(rect, bounds) else { return false }
        let text = label(node).trimmingCharacters(in: .whitespaces)
        // On the verified WeCom build, the camera menu is the single unnamed
        // AXButton here. Pin is AXCheckBox; close/minimize have AXSubrole.
        return string(node, "AXSubrole").isEmpty && (text.isEmpty || text.lowercased().contains("camera") || text.contains("摄像头"))
    }
    guard candidates.count == 1 else {
        throw Failure("无法唯一识别通话右上角摄像头按钮。请把鼠标移入通话窗口显示控件后重试；未点击其他按钮。")
    }
    return candidates[0]
}
func obsReady(_ app: NSRunningApplication) -> Bool {
    elements(root(app), "AXWindows").flatMap { tree($0) }.contains {
        ["停止虚拟摄像机", "停止虚拟摄像头", "Stop Virtual Camera"].contains(string($0, "AXTitle"))
    }
}
func startOBS(_ app: NSRunningApplication) throws {
    if obsReady(app) { print("OBS 虚拟摄像头已开启。"); return }
    let deadline = Date().addingTimeInterval(20)
    var sentStart = false
    while Date() < deadline {
        if obsReady(app) { print("OBS 虚拟摄像头已开启，沿用当前场景。"); return }
        let nodes = elements(root(app), "AXWindows").flatMap { tree($0) }
        if !sentStart, let button = nodes.first(where: {
            string($0, "AXRole") == "AXButton" && ["启动虚拟摄像机", "启动虚拟摄像头", "Start Virtual Camera"].contains(string($0, "AXTitle"))
        }) {
            try press(button); sentStart = true
        }
        // Do not accept empty-source dialogs or system extension permissions.
        Thread.sleep(forTimeInterval: 0.5)
    }
    throw Failure("OBS 未确认虚拟摄像头启动。请检查 OBS 的来源、弹窗或系统相机扩展；脚本没有替你确认弹窗。")
}
func cameraItems(_ app: NSRunningApplication, _ window: AXUIElement) -> [AXUIElement] {
    // Restrict traversal to call window and exposed menus, excluding chat windows.
    var nodes = tree(window, depth: 5)
    for child in elements(root(app), "AXChildren") where string(child, "AXRole") == "AXMenu" {
        nodes += tree(child, depth: 3)
    }
    // Newer clients expose the hover device list as a separate small popup.
    for popup in elements(root(app), "AXWindows") where !CFEqual(popup, window) {
        if let r = frame(popup), r.width <= 600, r.height <= 500 { nodes += tree(popup, depth: 8) }
    }
    var matches: [AXUIElement] = []
    for node in nodes where ["AXTitle", "AXDescription", "AXValue"].contains(where: { string(node, $0).trimmingCharacters(in: .whitespacesAndNewlines) == "OBS Virtual Camera" }) {
        var candidate: AXUIElement? = node
        for _ in 0..<3 {
            guard let current = candidate else { break }
            var actions: CFArray?
            AXUIElementCopyActionNames(current, &actions)
            if ["AXMenuItem", "AXButton", "AXRadioButton", "AXRow", "AXCell", "AXCheckBox"].contains(string(current, "AXRole")),
               (actions as? [String] ?? []).contains(kAXPressAction as String) {
                if !matches.contains(where: { CFEqual($0, current) }) { matches.append(current) }
                break
            }
            if let parent = attribute(current, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() { candidate = unsafeBitCast(parent, to: AXUIElement.self) }
            else { candidate = nil }
        }
    }
    return matches
}
// AXSelected only means menu highlighting; the mark character identifies the
// active camera. Re-selecting it can restart WeCom's camera capture pipeline.
func cameraIsMarked(_ mark: String) -> Bool {
    !mark.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}
struct CameraCalibration: Codable {
    let x: Double, y: Double, width: Double, height: Double
    let appVersion: String
}
func cameraProgress(_ message: String) {
    fputs("摄像头选择：\(message)\n", stderr); fflush(stderr)
}
func cameraFingerprint(_ file: URL) throws -> [Double] {
    guard let bitmap = NSBitmapImageRep(data: try Data(contentsOf: file)), bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0 else { throw Failure("摄像头按钮模板不可读取。") }
    return (0..<256).map { index in
        let x = min(bitmap.pixelsWide - 1, (index % 16) * bitmap.pixelsWide / 16)
        let y = min(bitmap.pixelsHigh - 1, (index / 16) * bitmap.pixelsHigh / 16)
        guard let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { return 0 }
        return Double(c.redComponent * 0.299 + c.greenComponent * 0.587 + c.blueComponent * 0.114)
    }
}
func cameraFingerprintMatches(_ expected: [Double], _ actual: [Double]) -> Bool {
    guard expected.count == 256, actual.count == 256 else { return false }
    let mean = expected.reduce(0, +) / 256, otherMean = actual.reduce(0, +) / 256
    let variance = expected.reduce(0) { $0 + pow($1 - mean, 2) } / 256
    let error = zip(expected, actual).reduce(0) { $0 + pow(($1.0 - mean) - ($1.1 - otherMean), 2) } / 256
    let inverseError = zip(expected, actual).reduce(0) { $0 + pow(($1.0 - mean) + ($1.1 - otherMean), 2) } / 256
    return variance > 0.003 && min(error, inverseError) < 0.012
}
func screenshotButton(at point: CGPoint, to file: URL) throws {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-R", "\(Int(point.x - 14)),\(Int(point.y - 14)),28,28", file.path]
    task.standardError = FileHandle.nullDevice
    try task.run(); task.waitUntilExit()
    guard task.terminationStatus == 0 else { throw Failure("无法核验摄像头按钮，请检查屏幕录制权限。") }
}
func locateCameraImage(template: URL, in region: CGRect) throws -> CGPoint {
    let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wecom-controls-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: file) }
    let task = Process(); task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-R", "\(Int(region.minX)),\(Int(region.minY)),\(Int(region.width)),\(Int(region.height))", file.path]
    task.standardError = FileHandle.nullDevice
    try task.run(); task.waitUntilExit()
    guard task.terminationStatus == 0, let bitmap = NSBitmapImageRep(data: try Data(contentsOf: file)) else { throw Failure("无法读取当前通话控制区域。") }
    let expected = try cameraFingerprint(template)
    let expectedMean = expected.reduce(0,+) / 256
    let width = bitmap.pixelsWide, height = bitmap.pixelsHigh
    let scale = Double(width) / region.width, size = max(16, Int(28 * scale))
    guard width > size, height > size else { throw Failure("通话控制区域尺寸不足。") }
    var gray = [Double](repeating: 0, count: width * height)
    for y in 0..<height { for x in 0..<width {
        if let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) { gray[y * width + x] = Double(c.redComponent * 0.299 + c.greenComponent * 0.587 + c.blueComponent * 0.114) }
    } }
    var best: (CGPoint, Double)?, matches: [CGPoint] = []
    let offsets = (0..<256).map { (($0 / 16) * size / 16) * width + ($0 % 16) * size / 16 }
    for y in stride(from: 0, through: height-size, by: 2) { for x in stride(from: 0, through: width-size, by: 2) {
        let base = y * width + x
        var total = 0.0, squares = 0.0, cross = 0.0
        for i in 0..<256 { let a = gray[base + offsets[i]], d = expected[i] - a; total += d; squares += d*d; cross += expected[i]*a }
        let error = min(squares / 256 - pow(total / 256, 2), (squares+4*cross)/256 - pow(2*expectedMean-total/256,2))
        if error < 0.012 {
            let point = CGPoint(x: region.minX + (Double(x) + Double(size)/2)/scale, y: region.minY + (Double(y) + Double(size)/2)/scale)
            matches.append(point)
            if best == nil || error < best!.1 { best = (point, error) }
        }
    } }
    guard let (point, _) = best, matches.allSatisfy({ hypot($0.x-point.x, $0.y-point.y) < 14 }) else { throw Failure("未找到唯一的摄像头图标，请显示通话控制栏或重新定位。") }
    return point
}
func modernCallWindow(_ id: UInt32, app: NSRunningApplication) throws -> AXUIElement {
    let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let info = infos.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id && ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier }),
          let dictionary = info[kCGWindowBounds as String] as? [String: Any], let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
          abs(bounds.width - 360) <= 3, abs(bounds.height - 640) <= 3 else { throw Failure("请求的新版通话窗口已关闭或样式不匹配。") }
    let windows = elements(root(app), "AXWindows").filter { window in
        guard let r = frame(window) else { return false }
        return abs(r.minX - bounds.minX) < 2 && abs(r.minY - bounds.minY) < 2 && abs(r.width - bounds.width) < 2 && abs(r.height - bounds.height) < 2
    }
    guard windows.count == 1 else { throw Failure("无法唯一关联新版通话窗口。") }
    return windows[0]
}
func hoverCamera(_ app: NSRunningApplication, _ window: AXUIElement) throws -> (CGPoint?, CGPoint) {
    let directory = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.deletingLastPathComponent()
    let calibration: CameraCalibration
    do { calibration = try JSONDecoder().decode(CameraCalibration.self, from: Data(contentsOf: directory.appendingPathComponent("camera-button.json"))) }
    catch { throw Failure("新版悬停入口尚未定位，请先执行 --calibrate-camera。") }
    let version = app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String } ?? ""
    guard let axBounds = frame(window), calibration.appVersion == version,
          let bounds = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]])?.compactMap({ info -> CGRect? in
              guard (info[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier,
                    let d = info[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: d as CFDictionary),
                    abs(r.minX - axBounds.minX) < 2, abs(r.minY - axBounds.minY) < 2,
                    abs(r.width - axBounds.width) < 2, abs(r.height - axBounds.height) < 2 else { return nil }
              return r
          }).first,
          abs(bounds.width - calibration.width) < 3, abs(bounds.height - calibration.height) < 3,
          calibration.x >= 14, calibration.x < bounds.width - 14, calibration.y >= 14, calibration.y < bounds.height - 14 else { throw Failure("企微版本或窗口大小变化，请重新定位摄像头按钮。") }
    let expectedTarget = CGPoint(x: bounds.minX + calibration.x, y: bounds.minY + calibration.y)
    // The new client hides all controls until the pointer first enters video.
    // This first hover must settle before locating/hovering the camera icon.
    var target = CGPoint(x: bounds.midX, y: bounds.minY + bounds.height * 0.35)
    let original = CGEvent(source: nil)?.location
    var completed = false
    defer {
        if !completed, let original, let current = CGEvent(source: nil)?.location, hypot(current.x-target.x, current.y-target.y) < 3 {
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: original, mouseButton: .left)?.post(tap: .cghidEventTap)
        }
    }
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
    cameraProgress("已进入视频区域，等待控制栏")
    Thread.sleep(forTimeInterval: 1.1)
    guard let afterEntry = CGEvent(source: nil)?.location, hypot(afterEntry.x-target.x, afterEntry.y-target.y) < 3,
          elements(root(app), "AXWindows").contains(where: { CFEqual($0, window) }) else { throw Failure("用户已移动鼠标或通话窗口关闭，取消摄像头选择。") }
    target = expectedTarget
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.3)
    let temporary = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wecom-camera-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try screenshotButton(at: target, to: temporary)
    if !cameraFingerprintMatches(try cameraFingerprint(directory.appendingPathComponent("camera-button.png")), try cameraFingerprint(temporary)) {
        cameraProgress("正在定位当前控制栏的摄像头图标")
        let located = try locateCameraImage(template: directory.appendingPathComponent("camera-button.png"), in: CGRect(x: bounds.minX, y: bounds.minY + bounds.height * 0.45, width: bounds.width, height: bounds.height * 0.55))
        guard let current = CGEvent(source: nil)?.location, hypot(current.x-target.x, current.y-target.y) < 3 else { throw Failure("用户已移动鼠标，取消自动定位。") }
        target = located
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.25)
        try screenshotButton(at: target, to: temporary)
        guard cameraFingerprintMatches(try cameraFingerprint(directory.appendingPathComponent("camera-button.png")), try cameraFingerprint(temporary)) else { throw Failure("摄像头图标已变化，取消悬停选择。") }
    }
    guard elements(root(app), "AXWindows").contains(where: { CFEqual($0, window) }) else { throw Failure("通话窗口已关闭。") }
    guard let current = CGEvent(source: nil)?.location, hypot(current.x - target.x, current.y - target.y) < 3 else { throw Failure("鼠标已由用户移动，取消自动悬停。") }
    cameraProgress("图标核验通过，悬停等待设备菜单")
    Thread.sleep(forTimeInterval: 1.1)
    completed = true
    return (original, target)
}
func isOBSCameraText(_ value: String) -> Bool {
    value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased() == "obs virtual camera"
}
func selectOBSCameraText(_ app: NSRunningApplication, _ window: AXUIElement, cursor: CGPoint?) throws -> Bool {
    guard let bounds = frame(window) else { return false }
    let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var regions = infos.compactMap { info -> CGRect? in
        guard (info[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier,
              let d = info[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: d as CFDictionary),
              r.width >= 100, r.width <= 600, r.height >= 28, r.height <= 500,
              r.intersects(bounds.insetBy(dx: -300, dy: -300)) else { return nil }
        return r
    }
    // Some builds draw the device list inside the call's control region.
    regions.append(CGRect(x: bounds.minX, y: bounds.minY + bounds.height * 0.45, width: bounds.width, height: bounds.height * 0.55))
    var matches: [CGPoint] = []
    for (index, region) in regions.enumerated() {
        cameraProgress("正在本机识别设备菜单 \(index+1)/\(regions.count)")
        let began = Date()
        let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wecom-camera-menu-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-R", "\(Int(region.minX)),\(Int(region.minY)),\(Int(region.width)),\(Int(region.height))", file.path]
        capture.standardError = FileHandle.nullDevice
        try capture.run(); capture.waitUntilExit()
        guard capture.terminationStatus == 0 else { continue }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate; request.recognitionLanguages = ["en-US"]; request.usesLanguageCorrection = false
        try VNImageRequestHandler(url: file, options: [:]).perform([request])
        for observation in request.results ?? [] {
            guard let text = observation.topCandidates(1).first, text.confidence >= 0.8, isOBSCameraText(text.string) else { continue }
            let box = observation.boundingBox
            let point = CGPoint(x: region.minX + box.midX * region.width, y: region.minY + (1-box.midY) * region.height)
            if !matches.contains(where: { hypot($0.x-point.x, $0.y-point.y) < 12 }) { matches.append(point) }
        }
        cameraProgress("菜单识别完成，耗时 \(String(format: "%.1f", Date().timeIntervalSince(began))) 秒，OBS 匹配 \(matches.count) 项")
        if !matches.isEmpty { break }
    }
    guard matches.count <= 1 else { throw Failure("菜单文字中有多个 OBS 设备选项，未选择。") }
    guard let target = matches.first else { return false }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
          elements(root(app), "AXWindows").contains(where: { CFEqual($0, window) }) else { throw Failure("通话窗口失去前台或已关闭，未选择设备。") }
    if let cursor, let current = CGEvent(source: nil)?.location, hypot(current.x-cursor.x, current.y-cursor.y) >= 3 { throw Failure("用户已移动鼠标，取消设备选择。") }
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
    cameraProgress("已找到唯一的 OBS Virtual Camera，正在选择")
    Thread.sleep(forTimeInterval: 0.15)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.08)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
    print("已按设备菜单完整名称选择 OBS Virtual Camera，请确认本地预览显示数字人画面。")
    return true
}
func selectOBS(_ app: NSRunningApplication, _ window: AXUIElement, verifyOBS: Bool = true, verifiedWindow: Bool = false) throws {
    guard let obs = application("com.obsproject.obs-studio"), !verifyOBS || obsReady(obs) else { throw Failure("OBS 虚拟摄像头已停止，请重新运行。") }
    app.activate(options: [])
    if verifiedWindow, let url = app.bundleURL {
        let foreground = Process(); foreground.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        foreground.arguments = ["-a", url.path]
        try foreground.run(); foreground.waitUntilExit()
        guard foreground.terminationStatus == 0 else { throw Failure("无法激活企微通话窗口。") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
    }
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    if verifiedWindow {
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { throw Failure("企微未进入前台，请关闭遮挡通话的窗口后重试。") }
    }
    var restoreCursor: (CGPoint?, CGPoint)?
    defer {
        if let (original, target) = restoreCursor, let original, let current = CGEvent(source: nil)?.location, hypot(current.x - target.x, current.y - target.y) < 3 {
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: original, mouseButton: .left)?.post(tap: .cghidEventTap)
        }
    }
    if let button = try? cameraButton(window, verifiedWindow: verifiedWindow) {
        try press(button)
    } else if verifiedWindow {
        restoreCursor = try hoverCamera(app, window)
    } else { throw Failure("未识别旧版右上角摄像头入口。") }
    var item: AXUIElement?
    for _ in 0..<12 {
        guard isCall(window) || (verifiedWindow && elements(root(app), "AXWindows").contains(where: { CFEqual($0, window) })) else { throw Failure("通话已结束，停止操作。") }
        let candidates = cameraItems(app, window)
        guard candidates.count <= 1 else { throw Failure("存在多个 OBS 摄像头选项，已停止自动选择。") }
        item = candidates.first
        if item != nil { break }
        Thread.sleep(forTimeInterval: 0.25)
    }
    guard let selected = item else {
        if verifiedWindow, try selectOBSCameraText(app, window, cursor: restoreCursor?.1) { return }
        throw Failure("摄像头菜单没有可唯一识别的 OBS Virtual Camera，或菜单未成功展开；没有选择其他设备。")
    }
    if cameraIsMarked(string(selected, "AXMenuItemMarkChar")) {
        if let parent = attribute(selected, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() {
            let menu = unsafeBitCast(parent, to: AXUIElement.self)
            if string(menu, "AXRole") == "AXMenu" { AXUIElementPerformAction(menu, kAXCancelAction as CFString) }
        }
        print("企微已选中 OBS Virtual Camera，保持当前摄像头连接。")
        return
    }
    try press(selected)
    print("已向企微菜单提交 OBS Virtual Camera 选择。")
    print("请确认右上角本地预览显示 OBS 内容；脚本不会读取或保存通话画面，不能自动判定视频内容。")
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    if args.contains("--help") {
        print("用法：CameraSwitch [--wait 秒数] [--watch] [--wecom-only] [--auto-answer] [--check | --self-test]\n新版摄像头：--calibrate-camera（鼠标停在按钮中心）；--select-camera-window 窗口ID。\n默认等待一对一视频聊天 180 秒；--watch 持续为新通话选择 OBS，不会主动拨号。--check 只读检查。")
        exit(0)
    }
    if args.contains("--self-test") {
        guard isOBSCameraText("OBS Virtual Camera"), isOBSCameraText(" OBS  Virtual Camera\n"),
              !isOBSCameraText("FaceTime Camera"), !isOBSCameraText("OBS Virtual Camera 2"), !isOBSCameraText("Not OBS Virtual Camera") else { throw Failure("OBS camera text self-test failed") }
        let cameraPattern = (0..<256).map { $0 % 3 == 0 ? 0.9 : 0.1 }
        guard cameraFingerprintMatches(cameraPattern, cameraPattern.map { $0 + 0.02 }),
              cameraFingerprintMatches(cameraPattern, cameraPattern.map { 1 - $0 }),
              !cameraFingerprintMatches(cameraPattern, (0..<256).map { $0 % 3 == 1 ? 0.9 : 0.1 }),
              !cameraFingerprintMatches(Array(repeating: 0.2, count: 256), Array(repeating: 0.2, count: 256)),
              !cameraFingerprintMatches(cameraPattern, []) else { throw Failure("camera fingerprint self-test failed") }
        guard cameraIsMarked("✓"), cameraIsMarked("✔"), !cameraIsMarked(""), !cameraIsMarked(" "), isTimer("00:39"), isTimer("1:00:39"), !isTimer("企业微信"), !isTimer("会议 12:30"),
              inCameraArea(CGRect(x: 600, y: 20, width: 40, height: 30), CGRect(x: 0, y: 0, width: 720, height: 1280)),
              !inCameraArea(CGRect(x: 600, y: 1200, width: 40, height: 30), CGRect(x: 0, y: 0, width: 720, height: 1280)),
              isIncomingLabels(["来电", "邀请你视频通话"], answerCount: 1, declineCount: 1),
              !isIncomingLabels(["视频通话"], answerCount: 1, declineCount: 1),
              !isIncomingLabels(["来电", "语音通话"], answerCount: 2, declineCount: 1),
              !isIncomingLabels(["来电", "语音通话"], answerCount: 1, declineCount: 0),
              !isIncomingLabels(["邀请你加入视频会议"], answerCount: 1, declineCount: 1) else { throw Failure("self-test failed") }
        let incomingBounds = CGRect(x: 100, y: 200, width: 296, height: 136)
        guard matchesIncomingIconLayout(incomingBounds, CGRect(x: 341, y: 288, width: 38, height: 38), CGRect(x: 283, y: 288, width: 38, height: 38), CGRect(x: 115, y: 293, width: 106, height: 28)),
              !matchesIncomingIconLayout(incomingBounds, CGRect(x: 283, y: 288, width: 38, height: 38), CGRect(x: 341, y: 288, width: 38, height: 38), CGRect(x: 115, y: 293, width: 106, height: 28)) else { throw Failure("incoming icon layout self-test failed") }
        let modernBounds = CGRect(x: 400, y: 300, width: 316, height: 157)
        let modernAnswer = CGRect(x: 648, y: 397, width: 48, height: 48)
        let modernDecline = CGRect(x: 576, y: 397, width: 48, height: 48)
        let modernMode = CGRect(x: 420, y: 404, width: 126, height: 33)
        guard matchesIncomingIconLayoutV5(modernBounds, modernAnswer, modernDecline, modernMode),
              !matchesIncomingIconLayoutV5(modernBounds, modernDecline, modernAnswer, modernMode),
              !matchesIncomingIconLayoutV5(incomingBounds, modernAnswer, modernDecline, modernMode),
              !matchesIncomingIconLayoutV5(modernBounds, modernAnswer.offsetBy(dx: 12, dy: 0), modernDecline, modernMode) else { throw Failure("modern incoming layout self-test failed") }
        print("PASS：通话窗口、来电接听唯一性和摄像头区域识别。未操作界面。")
        exit(0)
    }
    let known = Set(["--check", "--diagnose-incoming", "--calibrate-camera", "--select-camera-window", "--wait", "--watch", "--wecom-only", "--auto-answer"])
    let wecomOnly = args.contains("--wecom-only")
    let autoAnswer = args.contains("--auto-answer")
    let watch = args.contains("--watch")
    for arg in args where arg.hasPrefix("--") && !known.contains(arg) { throw Failure("未知参数：\(arg)") }
    if args.contains("--calibrate-camera") || args.contains("--select-camera-window") {
        guard AXIsProcessTrusted(), let app = application("com.tencent.WeWorkMac") else { throw Failure("需要企微运行，并授予启动终端辅助功能权限。") }
        if let index = args.firstIndex(of: "--select-camera-window") {
            guard index + 1 < args.count, let id = UInt32(args[index + 1]) else { throw Failure("缺少有效通话窗口 ID。") }
            try selectOBS(app, modernCallWindow(id, app: app), verifyOBS: false, verifiedWindow: true)
        } else {
            guard let cursor = CGEvent(source: nil)?.location else { throw Failure("无法读取鼠标位置。") }
            let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let candidates = infos.compactMap { info -> (UInt32, CGRect)? in
                guard (info[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier,
                      let id = info[kCGWindowNumber as String] as? UInt32,
                      let d = info[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: d as CFDictionary),
                      abs(r.width - 360) <= 3, abs(r.height - 640) <= 3, r.insetBy(dx: 14, dy: 14).contains(cursor) else { return nil }
                return (id, r)
            }
            guard candidates.count == 1 else { throw Failure("请将鼠标停在唯一的新版通话窗口的摄像头按钮中心。") }
            _ = try modernCallWindow(candidates[0].0, app: app)
            let r = candidates[0].1, directory = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.deletingLastPathComponent()
            let version = app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String } ?? ""
            let calibration = CameraCalibration(x: cursor.x-r.minX, y: cursor.y-r.minY, width: r.width, height: r.height, appVersion: version)
            let image = directory.appendingPathComponent("camera-button.png")
            try screenshotButton(at: cursor, to: image)
            let fingerprint = try cameraFingerprint(image)
            guard cameraFingerprintMatches(fingerprint, fingerprint) else { throw Failure("摄像头图标不清晰，请重新定位。") }
            try JSONEncoder().encode(calibration).write(to: directory.appendingPathComponent("camera-button.json"), options: .atomic)
            print("已保存新版摄像头按钮定位，之后会核验版本、窗口及按钮图像再悬停约 1 秒。")
        }
        exit(0)
    }
    var wait: Double = 180
    if let index = args.firstIndex(of: "--wait") {
        guard index + 1 < args.count, let value = Double(args[index + 1]), value >= 0, value <= 3600 else { throw Failure("--wait 必须为 0 到 3600 秒。") }
        wait = value
    }
    if args.contains("--check") {
        let trusted = AXIsProcessTrusted()
        print("辅助功能授权：\(trusted ? "已有" : "未授权")")
        print("OBS 运行：\(application("com.obsproject.obs-studio") != nil)")
        print("企微运行：\(application("com.tencent.WeWorkMac") != nil)")
        if trusted, let obs = application("com.obsproject.obs-studio") { print("OBS 虚拟摄像头运行：\(obsReady(obs))") }
        if trusted, let wecom = application("com.tencent.WeWorkMac") {
            let calls = elements(root(wecom), "AXWindows").filter(isCall)
            print("可识别一对一视频通话窗口数：\(calls.count)")
            if calls.count == 1 { print("可唯一识别摄像头按钮：\((try? cameraButton(calls[0])) != nil)") }
        }
        exit(trusted ? 0 : 2)
    }
    if args.contains("--diagnose-incoming") {
        guard AXIsProcessTrusted() else { throw Failure("诊断需要辅助功能权限。请从已授权的终端执行。") }
        var previous = ""
        for _ in 0..<90 {
            let data = try JSONSerialization.data(withJSONObject: incomingDiagnostics(), options: [.sortedKeys])
            let value = String(decoding: data, as: UTF8.self)
            if value != previous { print(value); fflush(stdout); previous = value }
            Thread.sleep(forTimeInterval: 1)
        }
        exit(0)
    }
    // Hold a process lock until exit so double-launching cannot toggle controls twice.
    let lockPath = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path + ".lock"
    let lockFD = Darwin.open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
        throw Failure("已有一个启动器正在运行，请在原来的终端窗口查看进度。")
    }
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options) else {
        throw Failure("首次使用需要你在系统设置 → 隐私与安全性 → 辅助功能中允许启动器或终端控制界面，然后在项目根目录重新执行 npm start。不要把权限授予不认识的程序。")
    }
    if application("com.obsproject.obs-studio") == nil { try launch("/Applications/OBS.app") }
    let startup = Date().addingTimeInterval(20)
    while application("com.obsproject.obs-studio") == nil && Date() < startup { Thread.sleep(forTimeInterval: 0.5) }
    guard let obs = application("com.obsproject.obs-studio") else { throw Failure("OBS 尚未启动。") }
    if !wecomOnly { try startOBS(obs) }
    if application("com.tencent.WeWorkMac") == nil {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.tencent.WeWorkMac") else { throw Failure("找不到企业微信。") }
        try launch(url.path)
    }
    print(watch ? "持续监控一对一通话；平台 --auto-answer 模式会接听可唯一确认的来电。" : "等待一对一视频聊天（最多 \(Int(wait)) 秒）。请自行拨打或接听；脚本不会发起通话。")
    fflush(stdout)
    let deadline = Date().addingTimeInterval(wait)
    var lastWindow: AXUIElement?
    var lastAnsweredWindow: AXUIElement?
    var activeCallID = ""
    repeat {
        if let wecom = application("com.tencent.WeWorkMac") {
            let windows = elements(root(wecom), "AXWindows")
            if autoAnswer {
                let incoming = windows.compactMap { window -> (AXUIElement, AXUIElement)? in
                    guard let answer = incomingAnswer(window) else { return nil }; return (window, answer)
                }
                if incoming.count == 1, let (window, answer) = incoming.first {
                    if lastAnsweredWindow == nil || !CFEqual(lastAnsweredWindow!, window) {
                        // Re-read immediately before acting; never accept a stale candidate.
                        if let fresh = incomingAnswer(window), CFEqual(fresh, answer) {
                            lastAnsweredWindow = window
                            do { try press(fresh); emitCallEvent("incoming_answer_requested") }
                            catch { fputs("接听失败：\(error)\n", stderr) }
                        }
                    }
                } else if incoming.isEmpty { lastAnsweredWindow = nil }
            }
            let calls = windows.filter(isCall)
            if calls.count > 1 { fputs("存在多个通话窗口，跳过自动选择。\n", stderr) }
            else if let window = calls.first {
                if lastWindow == nil || !CFEqual(lastWindow!, window) {
                    lastWindow = window; activeCallID = UUID().uuidString
                    emitCallEvent("call_connected", id: activeCallID, window: window)
                    let videoCall = tree(window, depth: 3).map(label).contains { $0.contains("转语音通话") || $0.contains("Switch to voice") }
                    if videoCall {
                        do { try selectOBS(wecom, window, verifyOBS: !wecomOnly) }
                        catch { fputs("摄像头选择未完成：\(error)\n", stderr) }
                    }
                    fflush(stdout)
                    if !watch { exit(0) }
                }
            } else if let previous = lastWindow, !windows.contains(where: { CFEqual($0, previous) && isTimer(string($0, "AXTitle")) }) {
                emitCallEvent("call_ended", id: activeCallID); lastWindow = nil; activeCallID = ""
            }
        }
        Thread.sleep(forTimeInterval: 1)
    } while watch || Date() < deadline
    throw Failure("等待结束：未找到一对一视频聊天窗口。OBS 保持开启，接通后在项目根目录重新执行 npm start。")
} catch {
    fputs("\n\(error)\n", stderr)
    exit(1)
}
