import os
import sys
import socket
import threading
import time
import webbrowser

def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def _set_base_dir():
    """เมื่อรันจาก PyInstaller bundle ให้ chdir ไปที่โฟลเดอร์ของ .exe
    เพื่อให้ config.json, embeddings.json, attendance.csv หาเจอ"""
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base)

def _open_browser(url: str, delay: float = 3.0):
    time.sleep(delay)
    webbrowser.open(url)

def main():
    _set_base_dir()

    ip = get_local_ip()
    port = 8000
    url = f"http://{ip}:{port}"

    border = "=" * 52
    print(border)
    print("  Attendance Cam Server กำลังทำงาน...")
    print(f"  พนักงานเปิด Browser แล้วไปที่:")
    print(f"  >> {url} <<")
    print(border)
    print("  กด Ctrl+C เพื่อหยุด Server")
    print(border)

    threading.Thread(target=_open_browser, args=(url,), daemon=True).start()

    import uvicorn
    uvicorn.run(
        "main_api_fixed:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
    )

if __name__ == "__main__":
    main()
