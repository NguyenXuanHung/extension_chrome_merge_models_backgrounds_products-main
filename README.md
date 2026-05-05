# Fashion Image Batch — Mẫu × Cảnh × Sản phẩm

Chrome Extension Manifest V3. Tự động ghép từng cặp **mẫu × cảnh × sản phẩm** rồi gửi 3 ảnh reference + prompt sang ChatGPT Image (tab user đang đăng nhập), chờ ảnh kết quả và lưu về folder output.

## Tính năng chính

- Chọn 4 folder: **Mẫu**, **Cảnh**, **Sản phẩm**, **Output**
- Chọn 1 file `prompt.txt` làm template với placeholder
- Tự build queue cross-product (`models × scenes × products` jobs)
- Aspect ratio chọn được (`9:16`, `1:1`, `4:5`, `16:9`) — tự append `Make the aspect ratio …`
- Prefix tên file output, retry, delay giữa job có jitter
- Resume từ job lỗi gần nhất, bỏ qua job đã có ảnh output
- Pause / Resume / Stop / Retry failed
- Export log dạng JSON / CSV
- Options page chỉnh selector và Test Detect khi UI ChatGPT đổi

## Cấu trúc thư mục

| File | Vai trò |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `popup.html` / `popup.css` / `popup.js` | Popup UI và orchestrator |
| `options.html` / `options.js` | Trang Options + Test Detect |
| `background.js` | Service worker — state, IPC, dispatch |
| `offscreen.html` / `offscreen.js` | Giữ FileSystem*Handle qua các lần SW ngủ + đọc/ghi file |
| `selectors.js` | Mặc định CSS selector cho composer / submit / upload / result |
| `chatgptAutomation.js` | Toolkit thao tác DOM ChatGPT (composer, upload, submit, wait, fetch) |
| `content.js` | Vòng lặp xử lý từng job trong tab ChatGPT |
| `lib/config.js` | Hằng số, default settings, message types |
| `lib/storage.js` | chrome.storage wrapper + recompute stats |
| `lib/idb.js` | Lưu FileSystemDirectoryHandle (4 folder + prompt.txt) |
| `lib/fileScanner.js` | Quét folder cho ảnh `jpg/jpeg/png/webp`, sort tự nhiên |
| `lib/jobBuilder.js` | Sinh queue cross-product, sanitize tên file |
| `lib/promptRenderer.js` | Render template với placeholder + aspect ratio |
| `lib/sanitize.js` | Sanitize tên file output |
| `lib/naturalSort.js` | Natural sort wrapper |
| `lib/logger.js` | Log helpers + export CSV/JSON |
| `lib/downloader.js` | Fallback `chrome.downloads` + base64 helpers |
| `examples/prompts.txt` | Mẫu prompt template |

## Cài extension

1. Mở Chrome → `chrome://extensions`
2. Bật `Developer mode`
3. Click `Load unpacked`, chọn folder dự án này
4. Pin icon extension cho dễ truy cập

Chrome cần hỗ trợ File System Access API (Chrome 86+ trên desktop). Lần đầu mở popup, mỗi folder sẽ hỏi quyền — chấp nhận `Allow on every visit` để tránh hỏi lại giữa batch.

## Prompt template

`prompt.txt` là plain text. Có thể chứa **nhiều prompt** cách nhau bởi 1 dòng chỉ có `===`. Mỗi block là 1 prompt độc lập.

Total jobs = `prompts × models × scenes × products`. Ví dụ 2 prompt × 2 mẫu × 2 cảnh × 2 sản phẩm = **16 jobs**.

Hỗ trợ placeholder:

| Token | Ý nghĩa |
| --- | --- |
| `{{MODEL_NAME}}` | tên file ảnh mẫu (ví dụ `model-1.jpg`) |
| `{{SCENE_NAME}}` | tên file ảnh cảnh |
| `{{PRODUCT_NAME}}` | tên file ảnh sản phẩm |
| `{{MODEL_BASENAME}}` | giống trên nhưng bỏ extension |
| `{{SCENE_BASENAME}}`, `{{PRODUCT_BASENAME}}` | tương tự |
| `{{INDEX}}` | số thứ tự job (1-based) |
| `{{TOTAL}}` | tổng số job |
| `{{PROMPT_INDEX}}` | thứ tự prompt block trong file (1-based) |
| `{{PROMPT_TOTAL}}` | tổng số prompt block |
| `{{ASPECT_RATIO}}` | tỉ lệ ảnh (lấy từ popup) |

Nếu template KHÔNG đề cập "aspect ratio" thì extension tự append:

```
Make the aspect ratio 9:16.
```

Xem `examples/prompts.txt` để có template mẫu.

## Hướng dẫn dùng nhanh

1. Đăng nhập ChatGPT thủ công trên `https://chatgpt.com` và mở chế độ Image.
2. Mở popup extension.
3. Bấm **Chọn** ở từng dòng folder: Mẫu, Cảnh, Sản phẩm, Output.
4. Bấm **Chọn** cho `prompt.txt`.
5. Chỉnh prefix, aspect ratio, delay, retry, các checkbox tuỳ ý.
6. Bấm **Build queue** — popup sẽ render danh sách job (mẫu × cảnh × sản phẩm).
7. Bấm **Start**. Popup có thể đóng — runner chạy bên trong tab ChatGPT.
8. Theo dõi progress, dùng Pause/Resume/Stop/Retry failed khi cần.
9. Hết queue → **Export JSON** / **Export CSV** để lưu log.

### Output filename

Mặc định:

```
{prefix}_{INDEX}_model-{MODEL_BASENAME}_scene-{SCENE_BASENAME}_product-{PRODUCT_BASENAME}.png
```

Tên file được sanitize (bỏ ký tự đặc biệt, đổi space → `-`, cắt nếu quá dài). Khi không bật Overwrite, file trùng được thêm hậu tố `_v2`, `_v3`, …

## Test Detect (khi UI ChatGPT đổi)

1. Mở popup → bấm **Options**.
2. Chỉnh các block selector cần thiết — mỗi dòng là 1 CSS selector.
3. Bấm **Lưu** rồi **Test Detect** để xác nhận tab ChatGPT đang detect được composer / file input / submit.
4. **Reset về mặc định** bất kỳ lúc nào.

## Checklist test nhanh (1 model × 1 scene × 1 product)

1. Tạo 3 folder, mỗi folder đúng 1 file ảnh (jpg/png).
2. Tạo 1 folder output trống.
3. Tạo `prompt.txt` ngắn (xem `examples/prompts.txt`).
4. Build queue → kiểm tra **1 jobs**.
5. Bật **Mock mode**, bấm Start → kiểm tra ảnh PNG mock được tạo trong folder output.
6. Tắt Mock mode, mở tab ChatGPT Image, đảm bảo có thể chat thủ công.
7. Bấm Start → quan sát: 3 ảnh thumbnail upload xong, prompt được paste, submit, ảnh xuất hiện, file PNG xuất hiện trong folder output.
8. Kiểm tra log: 1 dòng "Saved …".
9. Sau khi pass, mở rộng lên 2 × 2 × 2 để xác nhận cross-product = 8 jobs.

## Giới hạn kỹ thuật

- File System Access API yêu cầu user gesture cho mỗi lần khôi phục quyền — sau khi popup ngủ lâu, có thể phải bấm **Choose** lại folder output để refresh permission. Extension sẽ tự xin quyền lúc bấm **Start** nếu cần.
- Selectors mặc định được tune cho phiên bản ChatGPT hiện tại; OpenAI có thể đổi mà không thông báo. Khi đó dùng Options → Test Detect.
- Mỗi job upload đúng 3 ảnh; nếu ChatGPT không detect đủ thumbnail trong `uploadTimeoutMs` thì job fail và retry theo cấu hình.
- Extension không bypass captcha, không né rate-limit. Khi ChatGPT giới hạn user → extension báo lỗi và retry.
- Chỉ ảnh trên cùng (lớn nhất, ổn định) được tải — chưa hỗ trợ tải nhiều biến thể trong cùng 1 job.
- Subfolder scan: cấu trúc lồng quá sâu sẽ làm chậm scan; bật khi cần.

## Gợi ý selector khi ChatGPT đổi giao diện

| Mục | Bắt đầu thử |
| --- | --- |
| Composer | `div#prompt-textarea[contenteditable='true']`, `div.ProseMirror[contenteditable='true']`, `[role='textbox']` |
| File input | `input[type='file'][accept*='image']`, `input[type='file'][multiple]` |
| Drop zone | `form[data-type='unified-composer']`, `form` |
| Submit | `button[data-testid='send-button']`, `#composer-submit-button`, `form button[type='submit']` |
| Result image | `[data-message-author-role='assistant'] img`, `img[src^='blob:']`, `img[src*='oaiusercontent']` |
| Upload thumbnail | `[data-testid*='attachment'] img`, `form img[src^='blob:']` |
| Generating | `button[aria-label*='Stop' i]`, `[role='status']` |

Nếu tìm được selector mới ổn định, paste vào Options → Lưu là content script tự reload override.

## Permissions

- `storage` — queue, settings, logs
- `tabs` + `activeTab` — tìm tab ChatGPT
- `scripting` — inject content scripts vào tab đã mở từ trước
- `downloads` — fallback nếu File System Access bị từ chối
- `offscreen` — giữ FileSystem*Handle qua các lần SW ngủ
- Host: `https://chatgpt.com/*`, `https://chat.openai.com/*`

## Mock mode

Tick **Mock mode** trước khi Start để test:
- folder picker
- queue build
- file naming
- ghi vào folder output
- pause/resume/stop

Mock mode KHÔNG mở ChatGPT, chỉ tạo ảnh PNG cục bộ ghi label `Mock #i/n`.
