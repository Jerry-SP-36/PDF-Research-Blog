import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var backend: Process?
    var output = Data()
    var errorOutput = Data()
    var loaded = false
    var serviceOrigin: String?
    var childWindows: [NSWindow] = []
    let zoomDefaultsKey = "pdfResearchPageZoom"
    var pageZoom = 1.0
    var zoomStatusItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let root = NSMenuItem(); menu.addItem(root)
        let appMenu = NSMenu(); root.submenu = appMenu
        appMenu.addItem(withTitle: "結束 PDF Research", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenuItem(); menu.addItem(edit); let editMenu = NSMenu(title: "編輯"); edit.submenu = editMenu
        for (name, action, key) in [("復原", "undo:", "z"), ("剪下", "cut:", "x"), ("複製", "copy:", "c"), ("貼上", "paste:", "v"), ("全選", "selectAll:", "a")] {
            editMenu.addItem(withTitle: name, action: Selector(action), keyEquivalent: key)
        }
        let view = NSMenuItem(title: "顯示", action: nil, keyEquivalent: ""); menu.addItem(view); let viewMenu = NSMenu(title: "顯示"); view.submenu = viewMenu
        let zoomInItem = viewMenu.addItem(withTitle: "放大", action: #selector(zoomIn(_:)), keyEquivalent: "+"); zoomInItem.target = self
        let zoomOutItem = viewMenu.addItem(withTitle: "縮小", action: #selector(zoomOut(_:)), keyEquivalent: "-"); zoomOutItem.target = self
        let resetZoomItem = viewMenu.addItem(withTitle: "實際大小", action: #selector(resetZoom(_:)), keyEquivalent: "0"); resetZoomItem.target = self
        viewMenu.addItem(.separator())
        let zoomStatus = NSMenuItem(title: "縮放：100%", action: nil, keyEquivalent: "")
        zoomStatus.isEnabled = false; viewMenu.addItem(zoomStatus); zoomStatusItem = zoomStatus
        NSApp.mainMenu = menu
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self; webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "PDF Research"; window.minSize = NSSize(width: 900, height: 650)
        window.contentView = webView; window.center(); window.makeKeyAndOrderFront(nil)
        if UserDefaults.standard.object(forKey: zoomDefaultsKey) != nil {
            pageZoom = min(2.0, max(0.7, UserDefaults.standard.double(forKey: zoomDefaultsKey)))
        }
        applyZoom(pageZoom, persist: false)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<meta charset='utf-8'><body style='font:18px system-ui;padding:60px;background:#f2f4f6;color:#23374b'><h1>PDF Research</h1><p>正在啟動本機研究工作台…</p></body>", baseURL: nil)
        startBackend()
    }

    func startBackend() {
        guard let resources = Bundle.main.resourceURL else { showError("找不到 App 資源。"); return }
        let userHome = FileManager.default.homeDirectoryForCurrentUser
        let nodes = [userHome.appendingPathComponent(".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"), userHome.appendingPathComponent(".local/bin/node"), URL(fileURLWithPath: "/opt/homebrew/bin/node")]
        guard let node = nodes.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else { showError("找不到 Node.js。請確認 Codex 工作區執行環境已安裝。"); return }
        let process = Process(); backend = process
        process.executableURL = node
        let app = resources.appendingPathComponent("app")
        process.arguments = [app.appendingPathComponent("server.mjs").path]
        process.currentDirectoryURL = app
        var env = ProcessInfo.processInfo.environment
        env["PDF_RESEARCH_DATA_DIR"] = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("pdf-research-data").path
        env.removeValue(forKey: "CODEX_APP_TOOLS_PIPE_PATH"); env.removeValue(forKey: "CODEX_THREAD_ID")
        process.environment = env
        let stdout = Pipe(), stderr = Pipe(); process.standardOutput = stdout; process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { guard let self = self else { return }; self.errorOutput.append(data); if self.errorOutput.count > 8000 { self.errorOutput = self.errorOutput.suffix(8000) } }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if proc.terminationStatus != 0 { self.showError(String(data: self.errorOutput, encoding: .utf8) ?? "本機服務未能啟動。") }
            }
        }
        do { try process.run() } catch { showError(error.localizedDescription) }
    }

    func consume(_ data: Data) {
        output.append(data)
        while let newline = output.firstIndex(of: 10) {
            let line = output.prefix(upTo: newline); output.removeSubrange(...newline)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any], value["ready"] as? Bool == true,
                  let text = value["url"] as? String, let url = URL(string: text), url.host == "127.0.0.1", url.scheme == "http" else { continue }
            serviceOrigin = "http://127.0.0.1:\(url.port ?? 80)"
            loaded = true; webView.load(URLRequest(url: url))
        }
    }

    func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "PDF Research 啟動失敗"; alert.informativeText = message; alert.addButton(withTitle: "確定"); alert.runModal()
    }
    func applyZoom(_ value: Double, persist: Bool = true) {
        pageZoom = min(2.0, max(0.7, (value * 10).rounded() / 10))
        webView?.pageZoom = pageZoom
        zoomStatusItem?.title = "縮放：\(Int((pageZoom * 100).rounded()))%"
        if persist { UserDefaults.standard.set(pageZoom, forKey: zoomDefaultsKey) }
    }
    @objc func zoomIn(_ sender: Any?) { applyZoom(pageZoom + 0.1) }
    @objc func zoomOut(_ sender: Any?) { applyZoom(pageZoom - 0.1) }
    @objc func resetZoom(_ sender: Any?) { applyZoom(1.0) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { if backend?.isRunning == true { backend?.terminate() } }

    func isLocal(_ url: URL?) -> Bool {
        guard let url = url, let origin = serviceOrigin else { return url?.scheme == "about" }
        return "\(url.scheme ?? "")://\(url.host ?? ""):\(url.port ?? 80)" == origin
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard isLocal(navigationAction.request.url) else {
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, url.scheme == "https" {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel); return
        }
        if navigationAction.shouldPerformDownload { decisionHandler(.download) } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard isLocal(navigationAction.request.url) else { return nil }
        let view = WKWebView(frame: .zero, configuration: configuration); view.navigationDelegate = self; view.uiDelegate = self
        let viewer = NSWindow(contentRect: NSRect(x: 120, y: 80, width: 1100, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        viewer.title = "PDF Research — 來源文件"; viewer.contentView = view; viewer.isReleasedWhenClosed = false
        childWindows.append(viewer); viewer.makeKeyAndOrderFront(nil)
        return view
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename; panel.title = "儲存研究報告"
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate; app.setActivationPolicy(.regular); app.run()
