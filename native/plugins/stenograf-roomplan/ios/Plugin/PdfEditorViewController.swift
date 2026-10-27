import UIKit
import PDFKit
import PencilKit

/// Просмотр PDF (схема, «Работы и материалы») с той же панелью, что у снимка (2026-10-27, просьба пользователя):
/// сверху наши кнопки «‹», ↶, сохранить (в «Файлы»), «Поделиться»; рисование по страницам — палитрой Apple (PKToolPicker).
/// Каждой странице — свой прозрачный холст (PDFPageOverlayViewProvider, iOS 16+). При сохранении / отправке страницы
/// перерисовываются в новый PDF: исходная страница вектором, нарисованное поверх.
@available(iOS 16.0, *)
final class PdfEditorViewController: UIViewController, PDFPageOverlayViewProvider, PKCanvasViewDelegate {
    private let url: URL
    private let name: String
    private let pdfView = PDFView()
    private let picker = PKToolPicker()
    private var canvases: [PDFPage: PKCanvasView] = [:]
    private var history: [PKCanvasView] = []                 // в каком холсте был каждый штрих — для ↶
    private var strokeCounts: [ObjectIdentifier: Int] = [:]
    private let undoBtn = SmallGlassButton(symbol: "arrow.uturn.backward", label: "Отменить")

    init(url: URL, name: String) {
        self.url = url
        self.name = name
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: 0.93, alpha: 1)
        pdfView.translatesAutoresizingMaskIntoConstraints = false
        pdfView.backgroundColor = UIColor(white: 0.93, alpha: 1)
        pdfView.pageOverlayViewProvider = self
        pdfView.isInMarkupMode = true                       // касания — холстам страниц, а не выделению текста
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.autoScales = true
        pdfView.pageShadowsEnabled = true
        pdfView.document = PDFDocument(url: url)
        view.addSubview(pdfView)

        let back = SmallGlassButton(symbol: "chevron.left", label: "Назад")
        back.addTarget(self, action: #selector(close), for: .touchUpInside)
        undoBtn.addTarget(self, action: #selector(undo), for: .touchUpInside)
        undoBtn.isEnabled = false
        let save = SmallGlassButton(symbol: "arrow.down.circle", label: "Сохранить в «Файлы»", plain: true)
        save.addTarget(self, action: #selector(saveToFiles), for: .touchUpInside)
        let share = SmallGlassButton(symbol: "square.and.arrow.up", label: "Поделиться", plain: true)
        share.addTarget(self, action: #selector(sharePdf), for: .touchUpInside)
        let cap = GlassCapsule(buttons: [save, share])
        for v in [back, undoBtn, cap] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            pdfView.leadingAnchor.constraint(equalTo: view.leadingAnchor), pdfView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pdfView.topAnchor.constraint(equalTo: g.topAnchor, constant: 60), pdfView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            back.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            back.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            cap.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            cap.centerYAnchor.constraint(equalTo: back.centerYAnchor),
            undoBtn.trailingAnchor.constraint(equalTo: cap.leadingAnchor, constant: -10),
            undoBtn.centerYAnchor.constraint(equalTo: back.centerYAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        showPicker(for: canvases.values.first)
    }

    private func showPicker(for canvas: PKCanvasView?) {
        guard let c = canvas else { return }
        picker.addObserver(c)
        picker.setVisible(true, forFirstResponder: c)
        c.becomeFirstResponder()
    }

    // MARK: холсты страниц

    func pdfView(_ view: PDFView, overlayViewFor page: PDFPage) -> UIView? {
        if let c = canvases[page] { return c }
        let c = PKCanvasView()
        c.backgroundColor = .clear
        c.isOpaque = false
        c.drawingPolicy = .anyInput                 // и пальцем
        c.delegate = self
        canvases[page] = c
        picker.addObserver(c)
        if isViewLoaded && view.window != nil && canvases.count == 1 { DispatchQueue.main.async { self.showPicker(for: c) } }
        return c
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        let id = ObjectIdentifier(canvasView), n = canvasView.drawing.strokes.count
        if n > (strokeCounts[id] ?? 0) { history.append(canvasView) }
        strokeCounts[id] = n
        undoBtn.isEnabled = !history.isEmpty
    }

    @objc private func undo() {
        guard let c = history.popLast() else { return }
        var d = c.drawing
        if !d.strokes.isEmpty { d.strokes.removeLast() }
        strokeCounts[ObjectIdentifier(c)] = d.strokes.count
        c.drawing = d
        undoBtn.isEnabled = !history.isEmpty
    }

    @objc private func close() {
        for c in canvases.values { picker.setVisible(false, forFirstResponder: c); picker.removeObserver(c) }
        dismiss(animated: true)
    }

    // MARK: итоговый PDF

    /// страницы — вектором из исходного PDF, нарисованное — поверх (картинкой в размере страницы)
    private func resultURL() -> URL? {
        guard let doc = pdfView.document else { return nil }
        let hasInk = canvases.values.contains { !$0.drawing.strokes.isEmpty }
        if !hasInk { return url }
        let out = url.deletingLastPathComponent().appendingPathComponent(name + " (с пометками).pdf")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, .zero, nil)
        guard let ctx = UIGraphicsGetCurrentContext() else { return nil }
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let box = page.bounds(for: .mediaBox)
            UIGraphicsBeginPDFPageWithInfo(CGRect(origin: .zero, size: box.size), nil)
            ctx.saveGState()
            ctx.translateBy(x: 0, y: box.height); ctx.scaleBy(x: 1, y: -1)   // PDF — начало снизу, UIKit — сверху
            page.draw(with: .mediaBox, to: ctx)
            ctx.restoreGState()
            if let c = canvases[page], !c.drawing.strokes.isEmpty, c.bounds.width > 0 {
                let k = box.width / c.bounds.width
                c.drawing.image(from: c.bounds, scale: max(2, k * 2)).draw(in: CGRect(origin: .zero, size: box.size))
            }
        }
        UIGraphicsEndPDFContext()
        do { try data.write(to: out, options: .atomic) } catch { return nil }
        return out
    }

    @objc private func saveToFiles() {
        guard let u = resultURL() else { return }
        let picker = UIDocumentPickerViewController(forExporting: [u], asCopy: true)
        present(picker, animated: true)
    }

    @objc private func sharePdf() {
        guard let u = resultURL() else { return }
        let ac = UIActivityViewController(activityItems: [u], applicationActivities: nil)
        if let pop = ac.popoverPresentationController { pop.sourceView = view; pop.sourceRect = CGRect(x: view.bounds.maxX - 40, y: 60, width: 1, height: 1) }
        present(ac, animated: true)
    }
}
