# ActionSubGemini - Adobe Premiere Pro CEP Extension

Extension AI nhận diện hành vi / thao tác thị giác (Visual Action Recognition) cho Adobe Premiere Pro sử dụng Google Gemini 3.8 Flash API.

---

## 📁 Cấu Trúc Thư Mục
```text
ActionSubGemini/
├── CSXS/
│   └── manifest.xml       # Cấu hình CEP 11/12, quyền Node.js, kích thước panel
├── css/
│   └── style.css          # Giao diện Adobe Spectrum Dark theme
├── js/
│   ├── CSInterface.js     # Thư viện cầu nối CEP JavaScript Interface
│   └── main.js            # Node.js logic: Resumable Upload, Polling, Gemini API, SRT Sanitize
├── jsx/
│   └── host.jsx           # ExtendScript tương tác DOM Premiere Pro (lấy clip, import SRT)
├── index.html             # Giao diện điều khiển HTML5
├── package.json           # Thông tin extension
├── setup_debug.reg        # File Registry bật PlayerDebugMode cho Windows
└── README.md              # Hướng dẫn cài đặt & sử dụng
```

---

## 🚀 Hướng Dẫn Cài Đặt (Windows)

### Bước 1: Kích hoạt chế độ Debug Mode
1. Nhấp đúp chuột vào file [setup_debug.reg](file:///e:/tool/auto%20sub/ActionSubGemini/setup_debug.reg) và chọn **Yes** (Merge) để tự động kích hoạt `PlayerDebugMode=1` cho CSXS.9 đến CSXS.16.

### Bước 2: Copy Extension vào thư mục Premiere CEP
Copy toàn bộ thư mục `ActionSubGemini` vào một trong hai thư mục sau:

- **Dành cho tất cả người dùng (Khuyến nghị):**
  ```text
  C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\ActionSubGemini
  ```
- **Hoặc dành riêng cho User hiện tại:**
  ```text
  C:\Users\<Tên_User>\AppData\Roaming\Adobe\CEP\extensions\ActionSubGemini
  ```
  *(Nếu chưa có thư mục `CEP\extensions`, bạn chỉ cần tạo mới thư mục đó)*

### Bước 3: Mở Extension trong Premiere Pro
1. Khởi động (hoặc khởi động lại) **Adobe Premiere Pro**.
2. Trên thanh menu trên cùng, chọn:
   **Window** ➔ **Extensions** ➔ **Action Subtitle AI (Gemini)**.

---

## 🛠️ Hướng Dẫn Sử Dụng

1. **Nhập API Key:**
   - Dán Google Gemini API Key của bạn vào ô nhập (nhấn nút 👁️ để ẩn/hiện, nhấn *Lấy Key miễn phí ↗* nếu chưa có). Key được tự động lưu vào trình duyệt panel.
2. **Chọn ngôn ngữ phụ đề:**
   - Mặc định là Tiếng Việt, có thể chọn English hoặc tùy chỉnh.
3. **Tuỳ chọn nén video (FFmpeg):**
   - Đánh dấu chọn *"Tối ưu hoá video trước khi gửi (FFmpeg)"*. Extension sẽ tự động nén video xuống 480p, 2fps, bỏ audio. Video 8-10 phút sẽ giảm từ vài GB xuống chỉ còn 10-25MB, giúp upload và xử lý siêu tốc.
   - *Lưu ý: Đảm bảo máy tính đã cài đặt `ffmpeg` và có trong PATH hệ thống. Nếu không có FFmpeg, extension sẽ tự động gửi video gốc.*
4. **Chọn Video Clip:**
   - Click chọn 1 clip trong **Project Panel** hoặc chọn clip trên **Sequence Timeline**.
5. **Bấm "Phân Tích Hành Vi & Tạo SRT":**
   - Extension sẽ tự động xử lý toàn bộ 6 bước từ upload, polling trạng thái `ACTIVE`, gọi Gemini 3.8 Flash, tạo file `.srt` chuẩn cùng thư mục video và tự động import ngược vào Premiere Project.
