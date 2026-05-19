import os
import sys
import socket
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone

CERT_FILE = "cert.pem"
KEY_FILE = "key.pem"
PORT = 8443

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

def _generate_self_signed_cert(ip: str):
    """สร้าง self-signed cert ครอบคลุม localhost + IP ปัจจุบัน
    cert มีอายุ 10 ปี"""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import ipaddress

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "AttendanceCam Local Server"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "AttendanceCam"),
    ])

    san_list = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    try:
        san_list.append(x509.IPAddress(ipaddress.ip_address(ip)))
    except Exception:
        pass

    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    with open(KEY_FILE, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))

    with open(CERT_FILE, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

def _ensure_cert(ip: str):
    if not (os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)):
        print("กำลังสร้าง SSL certificate (ครั้งแรกเท่านั้น)...")
        _generate_self_signed_cert(ip)
        print("สร้าง cert สำเร็จ")

def _open_browser(url: str, delay: float = 3.0):
    time.sleep(delay)
    webbrowser.open(url)

def main():
    _set_base_dir()

    ip = get_local_ip()
    url = f"https://{ip}:{PORT}"

    _ensure_cert(ip)

    border = "=" * 60
    print(border)
    print("  Attendance Cam Server กำลังทำงาน...")
    print(f"  พนักงานเปิด Browser แล้วไปที่:")
    print(f"  >> {url} <<")
    print(border)
    print("  ครั้งแรก browser จะแจ้ง 'ไม่ปลอดภัย' ให้กด")
    print("  Advanced → Proceed to ... (unsafe)")
    print("  (เป็นเรื่องปกติของ self-signed cert)")
    print(border)
    print("  กด Ctrl+C เพื่อหยุด Server")
    print(border)

    threading.Thread(target=_open_browser, args=(url,), daemon=True).start()

    import uvicorn
    uvicorn.run(
        "main_api_fixed:app",
        host="0.0.0.0",
        port=PORT,
        log_level="info",
        ssl_certfile=CERT_FILE,
        ssl_keyfile=KEY_FILE,
    )

if __name__ == "__main__":
    main()
