# attendance_cam.spec
# สร้าง .exe ด้วย: pyinstaller attendance_cam.spec
# ต้องรันบน Windows เครื่องที่ติดตั้ง dependencies ครบแล้ว

import sys
from PyInstaller.utils.hooks import collect_all, collect_data_files

block_cipher = None

# รวบรวม TensorFlow และ DeepFace ซึ่งมี dynamic imports จำนวนมาก
tf_datas, tf_binaries, tf_hiddenimports = collect_all("tensorflow")
deepface_datas, deepface_binaries, deepface_hiddenimports = collect_all("deepface")
cv2_datas, cv2_binaries, cv2_hiddenimports = collect_all("cv2")
crypto_datas, crypto_binaries, crypto_hiddenimports = collect_all("cryptography")
# tf-keras (Keras 2) — DeepFace ต้องการตัวนี้ เพราะ Keras 3 ไม่ compatible
try:
    tfk_datas, tfk_binaries, tfk_hiddenimports = collect_all("tf_keras")
except Exception:
    tfk_datas, tfk_binaries, tfk_hiddenimports = [], [], []

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=tf_binaries + deepface_binaries + cv2_binaries + crypto_binaries + tfk_binaries,
    datas=[
        # Static frontend build
        ("frontend_dist", "frontend_dist"),
        # ข้อมูลที่ต้องมีตอน startup
        ("config.json", "."),
        ("embeddings.json", "."),
        ("attendance.csv", "."),
        ("odoo_sync.py", "."),
        # โฟลเดอร์เปล่าให้ PyInstaller สร้าง (ถ้ายังไม่มี)
        # registered_faces และ scan_logs จะถูกสร้างอัตโนมัติโดย main_api_fixed.py
    ] + tf_datas + deepface_datas + cv2_datas + crypto_datas + tfk_datas,
    hiddenimports=[
        "uvicorn",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "fastapi",
        "fastapi.staticfiles",
        "starlette.staticfiles",
        "starlette.routing",
        "pydantic",
        "multipart",
        "requests",
        "main_api_fixed",
        "odoo_sync",
        "cryptography",
        "cryptography.hazmat.backends.openssl",
        "cryptography.hazmat.bindings.openssl",
        "tf_keras",
    ] + tf_hiddenimports + deepface_hiddenimports + cv2_hiddenimports + crypto_hiddenimports + tfk_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "notebook", "IPython"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="AttendanceCam",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,   # แสดง console window เพื่อให้เห็น IP และ log
    icon=None,      # ใส่ path .ico ถ้ามี เช่น "assets/icon.ico"
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="AttendanceCam",   # โฟลเดอร์ผลลัพธ์: dist/AttendanceCam/
)
