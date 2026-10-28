import UIKit
import PencilKit
import Photos

/// Редактор снимка схемы / 3D на телефоне (2026-10-27, просьба пользователя): рисование — палитрой Apple (PKToolPicker —
/// внизу, сворачивается в кружок, перетаскивается и разворачивается, как в «Разметке»), сверху — наши кнопки, как были в
/// веб-редакторе: «‹» назад, ↶ отменить, сохранить в «Фото», «Поделиться». Нарисованное ложится на снимок в его полном размере.
final class ShotEditorViewController: UIViewController, PKCanvasViewDelegate {
    private let image: UIImage
    private let name: String
    private let imageView = UIImageView()
    private let canvas = PKCanvasView()
    private let picker = PKToolPicker()
    private let undoBtn = SmallGlassButton(symbol: "arrow.uturn.backward", label: "Отменить")
    private let toast = UILabel()

    init(image: UIImage, name: String) {
        self.image = image
        self.name = name
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: 0.93, alpha: 1)
        imageView.image = image
        imageView.contentMode = .scaleToFill            // рамку подгоняем сами под пропорции снимка
        view.addSubview(imageView)
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.drawingPolicy = .anyInput                // рисуем и пальцем, не только Pencil
        canvas.delegate = self
        canvas.isScrollEnabled = false
        view.addSubview(canvas)

        let back = SmallGlassButton(symbol: "chevron.left", label: "Назад")
        back.addTarget(self, action: #selector(close), for: .touchUpInside)
        undoBtn.addTarget(self, action: #selector(undo), for: .touchUpInside)
        undoBtn.isEnabled = false
        let save = SmallGlassButton(symbol: "arrow.down.circle", label: "Сохранить в «Фото»", plain: true)
        save.addTarget(self, action: #selector(saveToPhotos), for: .touchUpInside)
        let share = SmallGlassButton(symbol: "square.and.arrow.up", label: "Поделиться", plain: true)
        share.addTarget(self, action: #selector(shareImage), for: .touchUpInside)
        let cap = GlassCapsule(buttons: [save, share])
        for v in [back, undoBtn, cap] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            back.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            back.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            cap.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            cap.centerYAnchor.constraint(equalTo: back.centerYAnchor),
            undoBtn.trailingAnchor.constraint(equalTo: cap.leadingAnchor, constant: -10),
            undoBtn.centerYAnchor.constraint(equalTo: back.centerYAnchor),
        ])

        toast.translatesAutoresizingMaskIntoConstraints = false
        toast.textColor = .white
        toast.font = .systemFont(ofSize: 15, weight: .semibold)
        toast.textAlignment = .center
        toast.backgroundColor = UIColor(white: 0, alpha: 0.6)
        toast.layer.cornerRadius = 16
        toast.clipsToBounds = true
        toast.alpha = 0
        view.addSubview(toast)
        NSLayoutConstraint.activate([
            toast.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toast.topAnchor.constraint(equalTo: back.bottomAnchor, constant: 14),
            toast.heightAnchor.constraint(equalToConstant: 34),
            toast.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // снимок целиком, по центру, между верхними кнопками и низом экрана
        let top = view.safeAreaInsets.top + 64, bottom = view.safeAreaInsets.bottom + 8
        let area = CGRect(x: 8, y: top, width: view.bounds.width - 16, height: view.bounds.height - top - bottom)
        let k = min(area.width / image.size.width, area.height / image.size.height)
        let w = image.size.width * k, h = image.size.height * k
        let r = CGRect(x: area.midX - w / 2, y: area.minY + (area.height - h) / 2, width: w, height: h)
        if imageView.frame != r { imageView.frame = r; canvas.frame = r }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        picker.addObserver(canvas)
        picker.setVisible(true, forFirstResponder: canvas)
        canvas.becomeFirstResponder()
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        undoBtn.isEnabled = canvas.undoManager?.canUndo ?? !canvas.drawing.strokes.isEmpty
    }

    @objc private func close() {
        picker.setVisible(false, forFirstResponder: canvas)
        picker.removeObserver(canvas)
        dismiss(animated: true)
    }

    @objc private func undo() {
        if let um = canvas.undoManager, um.canUndo { um.undo() }
        else if !canvas.drawing.strokes.isEmpty { var d = canvas.drawing; d.strokes.removeLast(); canvas.drawing = d }
        canvasViewDrawingDidChange(canvas)
    }

    /// снимок + нарисованное в полном размере снимка
    private func result() -> UIImage {
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        let full = CGRect(origin: .zero, size: image.size)
        let k = canvas.bounds.width > 0 ? image.size.width / canvas.bounds.width : 1
        let ink = canvas.drawing.image(from: canvas.bounds, scale: k)
        return UIGraphicsImageRenderer(size: image.size, format: fmt).image { _ in
            image.draw(in: full)
            ink.draw(in: full)
        }
    }

    @objc private func saveToPhotos() {
        let img = result()
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            DispatchQueue.main.async {
                guard status == .authorized || status == .limited else {
                    let ac = UIAlertController(title: nil, message: "Нет доступа к «Фото». Откройте настройки Fixpoint → «Фото» и выберите «Добавлять фото» или «Полный доступ».", preferredStyle: .alert)
                    ac.addAction(UIAlertAction(title: "Отмена", style: .cancel))
                    ac.addAction(UIAlertAction(title: "Открыть настройки", style: .default) { _ in
                        if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
                    })
                    self.present(ac, animated: true)
                    return
                }
                PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.creationRequestForAsset(from: img) }) { ok, err in
                    DispatchQueue.main.async { self.showToast(ok ? "Сохранено в «Фото»" : "Не удалось сохранить") }
                }
            }
        }
    }

    @objc private func shareImage() {
        guard let data = result().jpegData(compressionQuality: 0.92) else { return }
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name + ".jpg")
        guard (try? data.write(to: url, options: .atomic)) != nil else { showToast("Не удалось сохранить файл"); return }
        let ac = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let pop = ac.popoverPresentationController { pop.sourceView = view; pop.sourceRect = CGRect(x: view.bounds.maxX - 40, y: 60, width: 1, height: 1) }
        present(ac, animated: true)
    }

    private func showToast(_ text: String) {
        toast.text = "   " + text + "   "
        UIView.animate(withDuration: 0.2) { self.toast.alpha = 1 }
        UIView.animate(withDuration: 0.3, delay: 1.6, options: []) { self.toast.alpha = 0 }
    }
}

/// Круглая стеклянная кнопка 44 pt (верхняя панель редактора): жидкое стекло iOS 26, раньше — размытие; нажатие — «вспухает».
/// plain — без своего стекла (кнопка внутри капсулы GlassCapsule).
final class SmallGlassButton: UIButton {
    static let side: CGFloat = 44
    init(symbol: String, label: String, plain: Bool = false) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        if !plain {
            let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
            glass.isUserInteractionEnabled = false
            glass.frame = CGRect(x: 0, y: 0, width: Self.side, height: Self.side)
            glass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            if !applyLiquidGlass(glass, tint: nil) { glass.backgroundColor = UIColor(white: 0, alpha: 0.12) }
            insertSubview(glass, at: 0)
            layer.cornerRadius = Self.side / 2
            layer.cornerCurve = .continuous
            layer.masksToBounds = true
        }
        tintColor = .white
        // в капсуле — без своего круга, поэтому шире и значок крупнее: рядом с отдельными кружками не выглядит мельче (2026-10-27)
        setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: plain ? 20 : 18, weight: .semibold)), for: .normal)
        widthAnchor.constraint(equalToConstant: plain ? 52 : Self.side).isActive = true
        heightAnchor.constraint(equalToConstant: Self.side).isActive = true
        accessibilityLabel = label
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layoutSubviews() { super.layoutSubviews(); if let iv = imageView { bringSubviewToFront(iv) } }
    override var isHighlighted: Bool {
        didSet {
            guard oldValue != isHighlighted, !(superview?.superview is GlassCapsule) else { return }
            springScale(self, isHighlighted)
        }
    }
    override var isEnabled: Bool { didSet { alpha = isEnabled ? 1 : 0.4 } }
}

/// Капсула из жидкого стекла с несколькими кнопками (сохранить · поделиться): нажатие любой — «вспухает» вся капсула.
final class GlassCapsule: UIView {
    init(buttons: [SmallGlassButton]) {
        super.init(frame: .zero)
        let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
        glass.translatesAutoresizingMaskIntoConstraints = false
        glass.isUserInteractionEnabled = false
        if !applyLiquidGlass(glass, tint: nil) { glass.backgroundColor = UIColor(white: 0, alpha: 0.12) }
        addSubview(glass)
        let stack = UIStackView(arrangedSubviews: buttons)
        stack.axis = .horizontal
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            glass.leadingAnchor.constraint(equalTo: leadingAnchor), glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor), glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4), stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        layer.cornerRadius = SmallGlassButton.side / 2
        layer.cornerCurve = .continuous
        layer.masksToBounds = true
        for b in buttons {
            b.addTarget(self, action: #selector(down), for: [.touchDown, .touchDragEnter])
            b.addTarget(self, action: #selector(up), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func down() { springScale(self, true) }
    @objc private func up() { springScale(self, false) }
}

/// «Вспухание» при нажатии, как у кнопок жидкого стекла в приложении: ×1,08, отпустили — упругий возврат
private func springScale(_ v: UIView, _ on: Bool) {
    UIView.animate(withDuration: on ? 0.22 : 0.5, delay: 0, usingSpringWithDamping: on ? 0.8 : 0.45, initialSpringVelocity: 0.6,
                   options: [.allowUserInteraction, .beginFromCurrentState]) {
        v.transform = on ? CGAffineTransform(scaleX: 1.08, y: 1.08) : .identity
    }
}
