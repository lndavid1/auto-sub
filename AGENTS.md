# GitHub Auto-Sync Rule (`lndavid1/auto-sub`)

- Repository: `https://github.com/lndavid1/auto-sub.git` (branch `main`).
- Mọi chỉnh sửa code trong workspace `E:\tool\auto sub` đều được tự động commit và push lên GitHub của `lndavid1` thông qua:
  1. Hook `.agents/hooks.json` (tự động chạy `.agents/scripts/auto_push.ps1` sau mỗi lần `edit_file` hoặc `write_file`).
  2. Trình theo dõi file thời gian thực `auto_sync_github.ps1` (FileSystemWatcher tự động commit & push khi file thay đổi).
- Nếu thực hiện thay đổi qua lệnh terminal (`run_command`), hãy chạy `powershell -NoProfile -ExecutionPolicy Bypass -File "E:\tool\auto sub\.agents\scripts\auto_push.ps1"` sau khi hoàn tất để đảm bảo GitHub luôn được cập nhật mới nhất.
