# แก้บรรทัดแรกของไฟล์
import os
# บังคับให้ TensorFlow ใช้ Keras 2 (tf-keras) ไม่ใช่ Keras 3
# เพราะ DeepFace ยังไม่ compatible กับ Keras 3 → จะเจอ
# "KerasHistory object has no attribute 'layer'" ตอน register
os.environ["TF_USE_LEGACY_KERAS"] = "1"
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
    "rtsp_transport;tcp"
    "|buffer_size;524288"       # ⭐ ลดจาก 2MB → 512KB
    "|stimeout;10000000"
    "|max_delay;500000"         # ⭐ เพิ่ม: จำกัด delay 0.5 วิ
    "|fflags;nobuffer"          # ⭐ เพิ่ม: ไม่ buffer เพิ่ม
    "|flags;low_delay"          # ⭐ เพิ่ม: โหมด low latency
)
import shutil
import cv2
import json
import numpy as np
import csv
import base64
import time
import threading
import logging
import secrets
from datetime import datetime, timezone, timedelta

BKK = timezone(timedelta(hours=7))

def now_bkk() -> datetime:
    return datetime.now(BKK)
from deepface import DeepFace
from fastapi import FastAPI, APIRouter, HTTPException, Header, Depends, Request
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from odoo_sync import odoo, OdooAttendance

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

DB_FILE = "embeddings.json"
LOG_FILE = "attendance.csv"
CONFIG_FILE = "config.json"
THRESHOLD = 0.60

# Load config
GEOFENCE_DEFAULT = {"lat": 16.4257442, "lon": 102.8318782, "radius": 100, "name": "AACC"}

def load_config():
    default = {"checkin_before": "08:00:00", "late_cutoff": "09:00:00", "checkout_after": "17:00:00", "cooldown_seconds": 300}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
                default.update(config)
        except Exception as e:
            log.warning(f"Config load error: {e}, using defaults")
    return default

CONFIG = load_config()
COOLDOWN = CONFIG["cooldown_seconds"]
CHECKIN_BEFORE = CONFIG["checkin_before"]
LATE_CUTOFF = CONFIG["late_cutoff"]
CHECKOUT_AFTER = CONFIG["checkout_after"]

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
api = APIRouter()

if not os.path.exists(LOG_FILE):
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        pass

DB = {}
if os.path.exists(DB_FILE):
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if content:
                DB = json.loads(content)
    except (json.JSONDecodeError, ValueError) as e:
        log.warning(f"embeddings.json เสียหายหรือว่าง — เริ่มต้นด้วย DB เปล่า ({e})")
        DB = {}

# Pre-computed normalized embedding matrix for fast cosine similarity
_emb_lock = threading.Lock()
_emb_matrix: np.ndarray = np.empty((0, 512), dtype=np.float32)
_emb_ids: list = []
_emb_names: list = []

def _rebuild_cache():
    global _emb_matrix, _emb_ids, _emb_names
    if not DB:
        with _emb_lock:
            _emb_matrix = np.empty((0, 512), dtype=np.float32)
            _emb_ids, _emb_names = [], []
        return
    ids = list(DB.keys())
    names = [DB[k]["name"] for k in ids]
    mat = np.array([DB[k]["embedding"] for k in ids], dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    mat /= np.maximum(norms, 1e-10)
    with _emb_lock:
        _emb_matrix, _emb_ids, _emb_names = mat, ids, names

_rebuild_cache()

last_checkin: dict = {}
camera_connected = False
live_reader = None
rtsp_url = ""
last_scan_event: dict = {}
_admin_tokens: set[str] = set()
_attendance_lock = threading.Lock()
_deepface_lock = threading.Lock()   # DeepFace.represent ไม่ thread-safe
_registering = False                # หยุด AI worker ระหว่างลงทะเบียน
_ai_resume_after: float = 0.0      # รอจนถึงเวลานี้ก่อนสแกนอีก (หลัง register)

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

def detect_faces(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
    """คืน list ของ (x, y, w, h) เรียงจากใหญ่สุดก่อน"""
    if frame is None or frame.size == 0:
        return []
    h, w = frame.shape[:2]
    if h < 120 or w < 120:
        return []
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    try:
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=6,       # เพิ่มจาก 5 → 6 ลด false positive
            minSize=(60, 60),
            maxSize=(int(w * 0.45), int(h * 0.45)),  # หน้าต้องไม่ใหญ่กว่า 45% ของเฟรม
        )
    except cv2.error:
        return []
    if len(faces) == 0:
        return []
    boxes = []
    for (x, y, fw, fh) in faces:
        ratio = fw / fh if fh > 0 else 0
        if 0.7 <= ratio <= 1.4:   # หน้าคนต้องใกล้เคียงสี่เหลี่ยมจัตุรัส
            boxes.append((x, y, fw, fh))
    boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
    return boxes

# --- Pydantic Models ---

class ScanRequest(BaseModel):
    image: str

class RegisterRequest(BaseModel):
    emp_id: str
    name: str
    email: str = ""
    phone: str = ""
    images: list[str]

class RegisterCCTVRequest(BaseModel):
    emp_id: str
    name: str
    email: str = ""
    phone: str = ""
    n_frames: int = 10

class AdminLogin(BaseModel):
    password: str

class TimeConfig(BaseModel):
    checkin_before: str   # "HH:MM:SS"
    late_cutoff: str
    checkout_after: str
    cooldown_seconds: int = 300

class DaySchedule(BaseModel):
    checkin_before: str   # "HH:MM:SS"
    late_cutoff: str
    checkout_after: str

class EmployeeSchedule(BaseModel):
    # key = "0"..="6" (จ=0, อ=1, พ=2, พฤ=3, ศ=4, ส=5, อา=6)
    days: dict[str, DaySchedule]

class EmployeeSchedule(BaseModel):
    checkin_before: str   # "HH:MM:SS"
    late_cutoff: str
    checkout_after: str

class AddFacesRequest(BaseModel):
    images: list[str]

class AddFacesCCTVRequest(BaseModel):
    n_frames: int = 10

class GeofenceConfig(BaseModel):
    lat: float
    lon: float
    radius: int = 100
    name: str = "Company"

class CameraConfig(BaseModel):
    rtsp_url: str

class OdooConfig(BaseModel):
    url: str
    db: str
    username: str
    api_key: str

def _require_admin(authorization: str | None = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if authorization[7:] not in _admin_tokens:
        raise HTTPException(status_code=401, detail="Invalid token")

# --- Business Logic ---

def _parse_hms(t) -> object:
    """แปลง "HH:MM:SS" หรือ int (hour เดิม) → time object สำหรับเปรียบเทียบ"""
    if isinstance(t, int):
        return datetime.strptime(f"{t:02d}:00:00", "%H:%M:%S").time()
    return datetime.strptime(str(t), "%H:%M:%S").time()

def _resolve_schedule(emp_id: str | None) -> dict:
    """คืน dict {checkin_before, late_cutoff, checkout_after} ของพนักงาน
    ถ้าวันนี้มี schedule เฉพาะ → ใช้นั้น  ไม่มี → global config"""
    cfg = load_config()
    base = {
        "checkin_before": cfg["checkin_before"],
        "late_cutoff": cfg["late_cutoff"],
        "checkout_after": cfg["checkout_after"],
    }
    if emp_id and emp_id in DB:
        today_str = str(now_bkk().weekday())  # 0=จ … 6=อา
        day_sched = DB[emp_id].get("schedule", {}).get(today_str)
        if day_sched:
            return day_sched
    return base

def get_action_by_time() -> str:
    s = _resolve_schedule(None)
    now_t = now_bkk().time()
    if now_t < _parse_hms(s["checkin_before"]):
        return "Check-In"
    elif now_t < _parse_hms(s["late_cutoff"]):
        return "Check-In (Late)"
    elif now_t < _parse_hms(s["checkout_after"]):
        return "Check-In (Late)"
    else:
        return "Check-Out"

def get_action_for_employee(emp_id: str) -> str:
    s = _resolve_schedule(emp_id)
    now_t = now_bkk().time()
    if now_t < _parse_hms(s["checkin_before"]):
        return "Check-In"
    elif now_t < _parse_hms(s["late_cutoff"]):
        return "Check-In (Late)"
    elif now_t < _parse_hms(s["checkout_after"]):
        return "Check-In (Late)"
    else:
        return "Check-Out"

def get_action_for_employee(emp_id: str) -> str:
    emp = DB.get(emp_id, {})
    sched = emp.get("schedule")
    if sched:
        now_t = now_bkk().time()
        if now_t < _parse_hms(sched["checkin_before"]):
            return "Check-In"
        elif now_t < _parse_hms(sched["late_cutoff"]):
            return "Check-In (Late)"
        elif now_t < _parse_hms(sched["checkout_after"]):
            return "Check-In (Late)"
        else:
            return "Check-Out"
    return get_action_by_time()

def get_today_records(eid: str) -> list:
    today = now_bkk().strftime("%Y-%m-%d")
    records = []
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) >= 5 and row[0] == eid and row[3] == today:
                    records.append(row)
    return records


def deepface_represent_safe(img, *, model_name: str = "ArcFace", enforce_detection: bool = False, detector_backend: str = "skip"):
    """เรียก DeepFace.represent แบบ thread-safe + fallback สำหรับอาการ KerasHistory/layer"""
    try:
        with _deepface_lock:
            return DeepFace.represent(
                img_path=img,
                model_name=model_name,
                enforce_detection=enforce_detection,
                detector_backend=detector_backend,
            )
    except Exception as e:
        msg = str(e)
        if "KerasHistory" in msg or "no attribute 'layer'" in msg or "has no attribute 'layer'" in msg:
            log.warning(f"DeepFace represent fallback due to keras/layer error: {msg}")
            with _deepface_lock:
                return DeepFace.represent(
                    img_path=img,
                    model_name=model_name,
                    enforce_detection=False,
                    detector_backend="skip",
                )
        raise


def find_match(face_img, skip_detect: bool = False, skip_if_busy: bool = False):
    with _emb_lock:
        mat, ids, names = _emb_matrix, _emb_ids, _emb_names

    if len(ids) == 0:
        return None, "Unknown", 0.0

    if skip_if_busy:
        acquired = _deepface_lock.acquire(blocking=False)
    else:
        acquired = _deepface_lock.acquire(blocking=True)
    if not acquired:
        return None, "busy", 0.0
    try:
        result = deepface_represent_safe(
            face_img,
            model_name="ArcFace",
            enforce_detection=False,
            detector_backend="skip" if skip_detect else "opencv",
        )
        query = np.array(result[0]["embedding"], dtype=np.float32)
        n = np.linalg.norm(query)
        if n > 1e-10:
            query /= n
    except Exception as e:
        log.warning(f"represent error: {e}")
        return None, "Unknown", 0.0
    finally:
        _deepface_lock.release()

    scores = mat @ query
    idx = int(np.argmax(scores))
    best_score = float(scores[idx])
    if best_score >= THRESHOLD:
        return ids[idx], names[idx], best_score
    return None, "Unknown", best_score

def _merge_embedding(old_emb: list, n_old: int, new_embeddings: list) -> tuple[list, int]:
    """Weighted average ของ embedding เก่า (n_old รูป) กับ embeddings ใหม่"""
    n_new = len(new_embeddings)
    merged = [
        (old_emb[i] * n_old + sum(e[i] for e in new_embeddings)) / (n_old + n_new)
        for i in range(len(old_emb))
    ]
    return merged, n_old + n_new


def _save_scan_log(frame: np.ndarray, box_xyxy: tuple | None, name: str, score: float) -> None:
    """บันทึก frame พร้อมกรอบหน้าลง scan_logs/YYYY-MM-DD/HHMMSSmmm_name_score.jpg"""
    try:
        now = now_bkk()
        date_dir = os.path.join("scan_logs", now.strftime("%Y-%m-%d"))
        os.makedirs(date_dir, exist_ok=True)

        img = frame.copy()
        recognized = name not in ("Unknown", "busy", "")
        color = (0, 200, 0) if recognized else (0, 0, 220)

        if box_xyxy is not None:
            x1, y1, x2, y2 = box_xyxy
            cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
            label = f"{name} {score:.2f}"
            label_y = max(y1 - 8, 16)
            cv2.putText(img, label, (x1, label_y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        safe_name = name.replace(" ", "_")[:24]
        fname = f"{now.strftime('%H%M%S%f')[:9]}_{safe_name}_{score:.2f}.jpg"
        cv2.imwrite(os.path.join(date_dir, fname), img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    except Exception as e:
        log.warning(f"scan_log save error: {e}")


def log_attendance(emp_id: str, name: str, action: str) -> bool:
    now = now_bkk()
    with _attendance_lock:
        today_records = get_today_records(emp_id)
        actions_today = [r[2] for r in today_records]

        if "Check-In" in action and any("Check-In" in a for a in actions_today):
            return False
        if "Check-Out" in action and any("Check-Out" in a for a in actions_today):
            return False

        key = f"{emp_id}_{now.strftime('%Y-%m-%d')}_{'in' if 'In' in action else 'out'}"
        if key in last_checkin:
            if (now - last_checkin[key]).total_seconds() < COOLDOWN:
                return False
        last_checkin[key] = now

        with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow([emp_id, name, action, now.strftime("%Y-%m-%d"), now.strftime("%H:%M:%S")])

    cfg_line = load_config()
    line_token = cfg_line.get('line_token')
    line_group_id = cfg_line.get('line_group_id')
    if line_token and line_group_id:
        try:
            import requests
            msg = f"👋 {action}: {name}  เวลา {now.strftime('%H:%M:%S')}"
            resp = requests.post(
                "https://api.line.me/v2/bot/message/push",
                headers={"Authorization": f"Bearer {line_token}", "Content-Type": "application/json"},
                json={"to": line_group_id, "messages": [{"type": "text", "text": msg}]},
                timeout=10
            )
            if resp.status_code == 200:
                log.info(f"✅ LINE push: {msg}")
            else:
                log.error(f"❌ LINE push failed [{resp.status_code}]: {resp.text}")
        except Exception as e:
            log.error(f"❌ LINE push error: {e}")

    # Odoo background
    def _push():
        try:
            if "Out" in action:
                odoo.push_checkout(name, now)
            else:
                odoo.push_checkin(name, now)
        except Exception as e:
            log.error(f"Odoo push error: {e}")
    threading.Thread(target=_push, daemon=True).start()

    return True

# --- CCTV Stream (Optimized) ---

class StreamReader:
    def __init__(self, url: str, reconnect: int = 10):
        self.url = url
        self.reconnect = reconnect
        self.lock = threading.Lock()
        self.running = True
        self.connected = False
        self.cap = None
        self._frame: np.ndarray | None = None
        self._frame_id: int = 0       # ⭐ นับเฟรมเพื่อเช็คเฟรมใหม่

        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        global camera_connected

        while self.running:
            # ---- reconnect ----
            if not self.cap or not self.cap.isOpened():
                log.info(f"Connecting to camera: {self.url}")
                self.connected = False
                camera_connected = False
                try:
                    cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 15000)
                    cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 15000)
                except Exception as e:
                    log.warning(f"VideoCapture error: {e}")
                    time.sleep(self.reconnect)
                    continue

                if not cap.isOpened():
                    log.warning("Camera open failed — retrying...")
                    time.sleep(self.reconnect)
                    continue

                ret, frame = cap.read()
                if not ret:
                    cap.release()
                    log.warning("First frame failed — retrying...")
                    time.sleep(self.reconnect)
                    continue

                self.cap = cap
                self.connected = True
                camera_connected = True
                with self.lock:
                    self._frame = frame
                    self._frame_id += 1
                log.info("✅ Camera connected!")
                continue

            # ---- drain buffer: อ่านเร็วสุดเท่าที่กล้องส่งมา ----
            # ⭐⭐⭐ จุดสำคัญ: ไม่มี sleep → เฟรมเก่าถูก overwrite → ไม่มี delay
            ret, frame = self.cap.read()
            if not ret:
                log.warning("Frame lost — reconnecting...")
                self.connected = False
                camera_connected = False
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None
                time.sleep(self.reconnect)
                continue

            with self.lock:
                self._frame = frame       # overwrite เฟรมเก่าทันที
                self._frame_id += 1

            # ⭐ ไม่ต้อง sleep!
            # cap.read() จะ block เองตาม RTSP framerate (~33ms ที่ 30fps)
            # ถ้าใส่ sleep → เฟรมค้างใน buffer → ภาพ delay → กระตุก

    def read(self) -> tuple[bool, np.ndarray | None]:
        """คืนเฟรมล่าสุด"""
        with self.lock:
            if self._frame is None:
                return False, None
            return True, self._frame.copy()

    def read_if_new(self, last_id: int) -> tuple[bool, np.ndarray | None, int]:
        """⭐ คืนเฟรมเฉพาะเมื่อเป็นเฟรมใหม่ — ลด copy ซ้ำซ้อน"""
        with self.lock:
            if self._frame is None or self._frame_id == last_id:
                return False, None, last_id
            return True, self._frame.copy(), self._frame_id

    def release(self):
        self.running = False
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass

def gen_frames():
    last_id = 0
    while True:
        if live_reader is None:
            time.sleep(1.0)
            continue

        # ⭐ อ่านเฉพาะเฟรมใหม่ — ไม่ copy ซ้ำ
        got_new, frame, last_id = live_reader.read_if_new(last_id)
        if not got_new:
            time.sleep(0.03)   # รอเฟรมใหม่
            continue

        h, w = frame.shape[:2]
        if w > 640:
            frame = cv2.resize(frame, (640, int(h * 640 / w)))

        ret2, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
        if ret2:
            yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buf.tobytes() + b'\r\n'
        time.sleep(0.066)  # ⭐ ~15 FPS สำหรับ browser

# --- AI Worker (Webcam-like sensitivity) ---

def ai_worker():
    global last_scan_event, _ai_resume_after
    last_ai_scan = 0.0
    last_frame_id = 0                          # ⭐ จุดที่ 1: เพิ่มตัวแปร

    AI_SCAN_INTERVAL = 1.0
    NO_FACE_SLEEP = 0.3
    IDLE_SLEEP = 0.2
    MAX_FACES_PER_FRAME = 1

    log.info("AI worker started — รอ ArcFace model โหลดเสร็จก่อน...")
    while not _model_ready:
        time.sleep(1)
    log.info("AI worker พร้อมสแกน CCTV")

    while True:
        if _registering:
            time.sleep(IDLE_SLEEP)
            continue
        if time.time() < _ai_resume_after:
            time.sleep(IDLE_SLEEP)
            continue
        if live_reader is None:
            time.sleep(1.0)
            continue

        elapsed = time.time() - last_ai_scan
        if elapsed < AI_SCAN_INTERVAL:
            time.sleep(AI_SCAN_INTERVAL - elapsed)
            continue

        # ⭐ จุดที่ 1: เปลี่ยนจาก read() → read_if_new()
        got_new, frame, last_frame_id = live_reader.read_if_new(last_frame_id)
        if not got_new:
            time.sleep(0.2)
            continue

        h, w = frame.shape[:2]
        det_width = 640
        if w > det_width:
            small = cv2.resize(frame, (det_width, int(h * det_width / w)))
        else:
            small = frame                      # ⭐ จุดที่ 2: ไม่ต้อง .copy()

        faces = detect_faces(small)

        if not faces:
            last_ai_scan = time.time()         # ⭐ อย่าลืม update เวลา
            time.sleep(NO_FACE_SLEEP)
            continue

        faces = faces[:MAX_FACES_PER_FRAME]
        scale_x = w / small.shape[1]
        scale_y = h / small.shape[0]

        for (x, y, fw, fh) in faces:
            pad = int(min(fw, fh) * 0.2)
            ox1 = max(0, int((x - pad) * scale_x))
            oy1 = max(0, int((y - pad) * scale_y))
            ox2 = min(w, int((x + fw + pad) * scale_x))
            oy2 = min(h, int((y + fh + pad) * scale_y))
            face_crop = frame[oy1:oy2, ox1:ox2]

            emp_id, name, score = find_match(
                face_crop, skip_detect=True, skip_if_busy=True
            )
            if name == "busy":
                break

            _save_scan_log(frame, (ox1, oy1, ox2, oy2), name, score)

            log.info(
                f"CCTV scan: {name} score={score:.3f} "
                f"crop={face_crop.shape[1]}x{face_crop.shape[0]}"
            )

            if emp_id:
                action = get_action_for_employee(emp_id)
                saved = log_attendance(emp_id, name, action)
                log.info(
                    f"CCTV — {action}: {name} ({score:.2f}) "
                    f"{'✓' if saved else '(ซ้ำ)'}"
                )
                last_scan_event = {
                    "name": name, "action": action,
                    "score": round(score, 2),
                    "time": now_bkk().isoformat(),
                    "saved": saved,
                }

        last_ai_scan = time.time()
        time.sleep(0.5)

_model_ready = False


def _warmup_model():
    global _model_ready
    log.info("กำลังโหลด ArcFace model (ครั้งแรกอาจใช้เวลา 1-3 นาที)...")
    try:
        dummy = np.zeros((112, 112, 3), dtype=np.uint8)
        DeepFace.represent(img_path=dummy, model_name="ArcFace", enforce_detection=False, detector_backend="skip")
        log.info("✅ ArcFace model พร้อมใช้งาน — ระบบ CCTV เริ่มสแกนได้แล้ว")
    except Exception as e:
        log.warning(f"Model warmup failed: {e}")
    finally:
        _model_ready = True

def sync_odoo_to_csv(date_from: str | None = None, date_to: str | None = None) -> int:
    """ดึง attendance จาก Odoo มาเพิ่มใน CSV สำหรับ record ที่ยังไม่มีในระบบ"""
    if not odoo.is_connected:
        return 0
    today = now_bkk().strftime("%Y-%m-%d")
    df = date_from or today
    dt = date_to or today
    records = odoo.fetch_attendance(df, dt)
    if not records:
        return 0

    # รวบรวม (ชื่อ_lower, action_type, date) ที่มีอยู่แล้วใน CSV
    existing: set[tuple[str, str, str]] = set()
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) >= 5:
                    atype = "in" if "In" in row[2] else "out"
                    existing.add((row[1].lower(), atype, row[3]))

    new_rows = []
    for r in records:
        name = r["employee_name"]
        emp_id = f"odoo_{r['id']}"
        ci_date = r.get("check_in_date", df)
        co_date = r.get("check_out_date", dt)
        if r["check_in"] and (name.lower(), "in", ci_date) not in existing:
            new_rows.append([emp_id, name, "Check-In", ci_date, r["check_in"]])
            existing.add((name.lower(), "in", ci_date))
        if r["check_out"] and (name.lower(), "out", co_date) not in existing:
            new_rows.append([emp_id, name, "Check-Out", co_date, r["check_out"]])
            existing.add((name.lower(), "out", co_date))

    if new_rows:
        with _attendance_lock:
            with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
                csv.writer(f).writerows(new_rows)
        log.info(f"Odoo sync: เพิ่ม {len(new_rows)} records ({df} → {dt})")
    return len(new_rows)


def _odoo_sync_worker():
    while True:
        try:
            sync_odoo_to_csv()
        except Exception as e:
            log.error(f"Odoo sync worker error: {e}")
        time.sleep(300)  # sync ทุก 5 นาที


threading.Thread(target=_warmup_model, daemon=True).start()
threading.Thread(target=ai_worker, daemon=True).start()
threading.Thread(target=_odoo_sync_worker, daemon=True).start()


# Auto-reconnect กล้องจาก config ที่บันทึกไว้
_saved_rtsp = load_config().get("rtsp_url", "")
if _saved_rtsp:
    log.info(f"Auto-reconnect กล้อง: {_saved_rtsp}")
    live_reader = StreamReader(_saved_rtsp)
    rtsp_url = _saved_rtsp


# --- API Endpoints ---

@api.get("/video_feed")
async def video_feed():
    return StreamingResponse(gen_frames(), media_type="multipart/x-mixed-replace; boundary=frame")

def _save_rtsp_url(url: str):
    cfg = load_config()
    cfg["rtsp_url"] = url
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

@api.post("/camera/connect")
async def camera_connect(config: CameraConfig, _: None = Depends(_require_admin)):
    global live_reader, rtsp_url, camera_connected
    if live_reader:
        live_reader.release()
        camera_connected = False
    rtsp_url = config.rtsp_url
    _save_rtsp_url(rtsp_url)
    live_reader = StreamReader(rtsp_url)
    return {"status": "connecting", "url": rtsp_url}

@api.post("/camera/disconnect")
async def camera_disconnect(_: None = Depends(_require_admin)):
    global live_reader, camera_connected, rtsp_url
    if live_reader:
        live_reader.release()
        live_reader = None
        camera_connected = False
        rtsp_url = ""
    _save_rtsp_url("")
    return {"status": "disconnected"}

@api.get("/camera/status")
async def get_camera_status():
    return {"connected": camera_connected, "url": rtsp_url, "last_event": last_scan_event}


@api.get("/odoo/status")
async def odoo_status():
    cfg = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                cfg = json.load(f).get("odoo", {})
        except Exception:
            pass
    return {
        "connected": odoo.is_connected,
        "url": cfg.get("url", ""),
        "db": cfg.get("db", ""),
        "username": cfg.get("username", ""),
        "error": getattr(odoo, '_error_msg', 'No error')
    }

@api.post("/odoo/config")
async def odoo_config(data: OdooConfig, _: None = Depends(_require_admin)):
    config = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
        except Exception:
            pass
    config["odoo"] = {
        "url": data.url.rstrip("/"),
        "db": data.db,
        "username": data.username,
        "api_key": data.api_key,
    }
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2)
    ok = odoo.reconnect()
    return {"status": "ok" if ok else "failed", "connected": ok}

@api.post("/scan")
async def scan_face(data: ScanRequest):
    try:
        header, encoded = data.image.split(",", 1)
        binary = base64.b64decode(encoded)
        nparr = np.frombuffer(binary, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        faces = detect_faces(frame)
        action = get_action_by_time()

        if faces:
            x, y, w, h = faces[0]
            pad = int(min(w, h) * 0.2)
            x1, y1 = max(0, x - pad), max(0, y - pad)
            x2, y2 = min(frame.shape[1], x + w + pad), min(frame.shape[0], y + h + pad)
            face_img = frame[y1:y2, x1:x2]
            emp_id, name, score = find_match(face_img, skip_detect=True)
            _save_scan_log(frame, (x1, y1, x2, y2), name, score)
        else:
            emp_id, name, score = find_match(frame, skip_detect=False)
            _save_scan_log(frame, None, name, score)

        status = "unknown"
        message = "ไม่พบในระบบ"
        if emp_id:
            action = get_action_for_employee(emp_id)
            saved = log_attendance(emp_id, name, action)
            if saved:
                status = "success"
                message = f"{action}: {name}"
            else:
                status = "cooldown"
                message = f"{name} (เช็คแล้ว)"
        return {
            "status": status,
            "name": name,
            "action": action,
            "message": message,
            "score": round(score, 2),
            "time": now_bkk().strftime("%H:%M:%S")
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@api.post("/odoo/sync")
async def odoo_sync(date: str | None = None, days: int = 30, _: None = Depends(_require_admin)):
    if not odoo.is_connected:
        raise HTTPException(status_code=400, detail="Odoo ไม่ได้เชื่อมต่อ")
    if date:
        added = sync_odoo_to_csv(date, date)
    else:
        today = now_bkk().strftime("%Y-%m-%d")
        date_from = (now_bkk() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        added = sync_odoo_to_csv(date_from, today)
    return {"status": "ok", "added": added}


@api.get("/odoo/attendance")
async def odoo_get_attendance(date: str | None = None, _: None = Depends(_require_admin)):
    if not odoo.is_connected:
        raise HTTPException(status_code=400, detail="Odoo ไม่ได้เชื่อมต่อ")
    target = date or now_bkk().strftime("%Y-%m-%d")
    records = odoo.fetch_attendance(target, target)
    return {"date": target, "records": records}


@api.post("/odoo/test")
async def odoo_test(_: None = Depends(_require_admin)):
    if not odoo.is_connected:
        raise HTTPException(status_code=400, detail="Odoo ไม่ได้เชื่อมต่อ")
    try:
        employees = odoo._models.execute_kw(
            odoo.db, odoo._uid, odoo.api_key,
            "hr.employee", "search_read",
            [[]],
            {"fields": ["id", "name"], "limit": 5},
        )
        return {"status": "ok", "sample_employees": employees}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api.get("/status")
async def get_status():
    return {"action": get_action_by_time(), "time": now_bkk().strftime("%H:%M:%S")}


@api.get("/stats")
async def get_stats():
    today = now_bkk().strftime("%Y-%m-%d")
    employees_today: set[str] = set()
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) >= 4 and row[3] == today:
                    employees_today.add(row[0])
    except:
        pass
    return {"total_employees": len(DB), "scanned_today": len(employees_today)}


@api.get("/logs")
async def get_logs():
    logs = []
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) >= 5:
                    logs.append({
                        "id": row[0], "name": row[1], "action": row[2],
                        "date": row[3], "time": row[4]
                    })
    except:
        pass
    return logs[::-1]


@api.delete("/logs")
async def clear_logs(_: None = Depends(_require_admin)):
    try:
        with open(LOG_FILE, "w", encoding="utf-8") as f:
            pass
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api.get("/employees")
async def list_employees():
    return [{"id": k, "name": v["name"], "schedule": v.get("schedule", {}), "face_count": v.get("face_count", 1)} for k, v in DB.items()]


@api.post("/register")
async def register_employee(data: RegisterRequest, _: None = Depends(_require_admin)):
    try:
        save_dir = os.path.join("registered_faces", f"{data.emp_id}_{data.name.replace(' ', '_')}")
        os.makedirs(save_dir, exist_ok=True)

        embeddings = []
        skipped = 0
        for i, img_base64 in enumerate(data.images):
            _, encoded = img_base64.split(",", 1)
            frame = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_COLOR)

            faces = detect_faces(frame)
            if faces:
                x, y, w, h = faces[0]
                pad = int(min(w, h) * 0.2)
                x1, y1 = max(0, x - pad), max(0, y - pad)
                x2, y2 = min(frame.shape[1], x + w + pad), min(frame.shape[0], y + h + pad)
                face_img = frame[y1:y2, x1:x2]
            else:
                # Haar หาไม่เจอ → ลอง DeepFace's own detector (แม่นกว่า)
                try:
                    extracted = DeepFace.extract_faces(
                        img_path=frame,
                        detector_backend="opencv",
                        enforce_detection=True,
                        align=True,
                    )
                    if extracted:
                        face_arr = extracted[0]["face"]
                        # extract_faces คืน float [0,1] — แปลงกลับเป็น uint8 BGR
                        if face_arr.dtype != np.uint8:
                            face_arr = (face_arr * 255).astype(np.uint8)
                        if face_arr.shape[-1] == 3:
                            face_img = cv2.cvtColor(face_arr, cv2.COLOR_RGB2BGR)
                        else:
                            face_img = face_arr
                    else:
                        raise ValueError("no face")
                except Exception:
                    skipped += 1
                    log.warning(f"register: รูป {i} ไม่พบใบหน้า — ข้าม")
                    continue

            cv2.imwrite(os.path.join(save_dir, f"face_{len(embeddings)}.jpg"), face_img)
            result = deepface_represent_safe(face_img, model_name="ArcFace", enforce_detection=False, detector_backend="skip")
            embeddings.append(result[0]["embedding"])

        if not embeddings:
            raise HTTPException(status_code=400, detail=f"ไม่พบใบหน้าในรูปทั้ง {len(data.images)} รูป — กรุณาถ่ายใหม่ให้เห็นหน้าชัด")

        avg = [sum(x) / len(x) for x in zip(*embeddings)]
        DB[data.emp_id] = {"name": data.name, "email": data.email, "phone": data.phone, "embedding": avg, "face_count": len(embeddings)}
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(DB, f, ensure_ascii=False, indent=2)
        _rebuild_cache()

        reg_file_path = os.path.join("register", "register.py")
        if os.path.exists(reg_file_path):
            with open(reg_file_path, "a", encoding="utf-8") as f:
                abs_save_dir = os.path.abspath(save_dir).replace("\\", "/")
                safe_id = data.emp_id.replace("\\", "\\\\").replace('"', '\\"')
                safe_name = data.name.replace("\\", "\\\\").replace('"', '\\"')
                f.write(f'\nregister("{safe_id}", "{safe_name}", "{abs_save_dir}")')

        odoo_id = odoo.create_employee(data.name, email=data.email, phone=data.phone)
        odoo_msg = f" (Odoo id={odoo_id})" if odoo_id else " (Odoo: ไม่ได้เชื่อมต่อ)"
        skip_note = f" ข้าม {skipped} รูปที่ไม่เห็นหน้า" if skipped else ""

        return {"status": "success", "message": f"ลงทะเบียน {data.name} เรียบร้อย ({len(embeddings)} รูป{skip_note}){odoo_msg}", "odoo_id": odoo_id}
    except Exception as e:
        log.error(f"Registration error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api.post("/register/cctv")
def register_from_cctv(data: RegisterCCTVRequest, _: None = Depends(_require_admin)):
    """ลงทะเบียนโดยจับภาพจาก CCTV stream โดยตรง (sync — รัน in thread pool)"""
    global _registering, _ai_resume_after
    if live_reader is None:
        raise HTTPException(status_code=400, detail="กล้อง CCTV ยังไม่เชื่อมต่อ")
    _registering = True
    log.info(f"หยุด AI worker ระหว่างลงทะเบียน {data.name}")
    try:
        save_dir = os.path.join("registered_faces", f"{data.emp_id}_{data.name.replace(' ', '_')}")
        os.makedirs(save_dir, exist_ok=True)

        def _sharpness(img: np.ndarray) -> float:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            return float(cv2.Laplacian(gray, cv2.CV_64F).var())

        # Phase 1: จับภาพให้ครบก่อน (ไม่เรียก DeepFace ระหว่างนี้ → เร็ว)
        crops: list[tuple[np.ndarray, float]] = []
        attempts = 0
        log.info(f"CCTV register phase1: จับภาพ {data.n_frames} เฟรมสำหรับ {data.name}")
        while len(crops) < data.n_frames and attempts < 150:
            attempts += 1
            ret, frame = live_reader.read()
            if not ret:
                time.sleep(0.1)
                continue
            faces = detect_faces(frame)
            if not faces:
                time.sleep(0.1)
                continue
            x, y, w, h = faces[0]
            pad = int(min(w, h) * 0.2)
            x1 = max(0, x - pad); y1 = max(0, y - pad)
            x2 = min(frame.shape[1], x + w + pad); y2 = min(frame.shape[0], y + h + pad)
            crop = frame[y1:y2, x1:x2]
            sharp = _sharpness(crop)
            if sharp < 20:
                time.sleep(0.1)
                continue
            crops.append((crop, sharp))
            time.sleep(0.15)

        if not crops:
            raise HTTPException(status_code=400, detail="ไม่พบใบหน้าในกล้อง — กรุณายืนหน้ากล้อง CCTV แล้วลองใหม่")

        # เรียงตาม sharpness สูงสุด เลือก top-n
        crops.sort(key=lambda c: c[1], reverse=True)
        best = crops[:data.n_frames]
        log.info(f"CCTV register: ได้ {len(best)} เฟรม (sharpness {best[0][1]:.1f}–{best[-1][1]:.1f})")

        # Phase 2: คำนวณ embedding (slow แต่ทำทีเดียวหลัง capture ครบ)
        embeddings = []
        for i, (crop, sharp) in enumerate(best):
            cv2.imwrite(os.path.join(save_dir, f"face_{i}.jpg"), crop)
            try:
                result = deepface_represent_safe(crop, model_name="ArcFace", enforce_detection=False, detector_backend="skip")
                embeddings.append(result[0]["embedding"])
                log.info(f"CCTV register embed {i+1}/{len(best)} done (sharp={sharp:.1f})")
            except Exception as e:
                log.warning(f"CCTV register embed error frame {i}: {e}")

        if not embeddings:
            raise HTTPException(status_code=400, detail="ไม่สามารถสร้าง embedding ได้ — ลองใหม่อีกครั้ง")

        avg = [sum(v) / len(v) for v in zip(*embeddings)]
        DB[data.emp_id] = {"name": data.name, "email": data.email, "phone": data.phone, "embedding": avg, "face_count": len(embeddings)}
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(DB, f, ensure_ascii=False, indent=2)
        _rebuild_cache()

        odoo_id = odoo.create_employee(data.name, email=data.email, phone=data.phone)
        log.info(f"CCTV register: ลงทะเบียน {data.name} เสร็จ ({len(embeddings)} เฟรม)")
        return {
            "status": "success",
            "captured": len(embeddings),
            "message": f"ลงทะเบียน {data.name} จาก CCTV เรียบร้อย ({len(embeddings)} เฟรม)",
            "odoo_id": odoo_id,
        }
    finally:
        _registering = False
        _ai_resume_after = time.time() + 5.0  # รอ 5 วิก่อนสแกน ให้คนออกจากกล้องก่อน
        log.info("AI worker กลับมาสแกนต่อใน 5 วินาที")


@api.post("/employees/{emp_id}/faces")
async def add_faces(emp_id: str, data: AddFacesRequest, _: None = Depends(_require_admin)):
    """เพิ่มรูปใบหน้าให้พนักงานที่ลงทะเบียนแล้ว (base64 images จาก webcam)"""
    if emp_id not in DB:
        raise HTTPException(status_code=404, detail="Employee not found")
    try:
        emp = DB[emp_id]
        name = emp["name"]
        save_dir = os.path.join("registered_faces", f"{emp_id}_{name.replace(' ', '_')}")
        os.makedirs(save_dir, exist_ok=True)

        existing_count = len([f for f in os.listdir(save_dir) if f.startswith("face_")])
        new_embeddings = []
        skipped = 0
        for i, img_base64 in enumerate(data.images):
            _, encoded = img_base64.split(",", 1)
            frame = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_COLOR)

            # crop ใบหน้าก่อน — ถ้าไม่ crop embedding จะมี background ปนทำให้สแกนมั่ว
            faces = detect_faces(frame)
            if faces:
                x, y, w, h = faces[0]
                pad = int(min(w, h) * 0.2)
                x1, y1 = max(0, x - pad), max(0, y - pad)
                x2, y2 = min(frame.shape[1], x + w + pad), min(frame.shape[0], y + h + pad)
                face_img = frame[y1:y2, x1:x2]
                backend = "skip"
            else:
                # ไม่เจอหน้า — ข้ามรูปนี้ไป ดีกว่าเอา background เข้าไป
                skipped += 1
                log.warning(f"add_faces: รูป {i} ไม่พบใบหน้า — ข้าม")
                continue

            cv2.imwrite(os.path.join(save_dir, f"face_{existing_count + len(new_embeddings)}.jpg"), face_img)
            with _deepface_lock:
                result = DeepFace.represent(img_path=face_img, model_name="ArcFace",
                                            enforce_detection=False, detector_backend=backend)
            new_embeddings.append(result[0]["embedding"])

        if not new_embeddings:
            raise HTTPException(status_code=400, detail=f"ไม่พบใบหน้าในรูปทั้ง {len(data.images)} รูป — กรุณาถ่ายใหม่ให้เห็นหน้าชัด")

        n_old = emp.get("face_count", 1)
        merged, n_total = _merge_embedding(emp["embedding"], n_old, new_embeddings)
        emp["embedding"] = merged
        emp["face_count"] = n_total
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(DB, f, ensure_ascii=False, indent=2)
        _rebuild_cache()

        skip_note = f" (ข้าม {skipped} รูปที่ไม่เห็นหน้า)" if skipped else ""
        log.info(f"add_faces: {name} +{len(new_embeddings)} รูป (รวม {n_total}){skip_note}")
        return {"status": "success", "added": len(new_embeddings), "total_faces": n_total,
                "message": f"เพิ่มรูป {name} อีก {len(new_embeddings)} รูป (รวมทั้งหมด {n_total} รูป){skip_note}"}
    except Exception as e:
        log.error(f"add_faces error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api.post("/employees/{emp_id}/faces/cctv")
def add_faces_cctv(emp_id: str, data: AddFacesCCTVRequest, _: None = Depends(_require_admin)):
    """เพิ่มรูปใบหน้าให้พนักงานที่ลงทะเบียนแล้ว โดยจับจาก CCTV stream"""
    global _registering, _ai_resume_after
    if emp_id not in DB:
        raise HTTPException(status_code=404, detail="Employee not found")
    if live_reader is None:
        raise HTTPException(status_code=400, detail="กล้อง CCTV ยังไม่เชื่อมต่อ")

    emp = DB[emp_id]
    name = emp["name"]
    _registering = True
    log.info(f"add_faces_cctv: หยุด AI worker ระหว่างเพิ่มรูป {name}")
    try:
        save_dir = os.path.join("registered_faces", f"{emp_id}_{name.replace(' ', '_')}")
        os.makedirs(save_dir, exist_ok=True)
        existing_count = len([f for f in os.listdir(save_dir) if f.startswith("face_")])

        def _sharpness(img: np.ndarray) -> float:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            return float(cv2.Laplacian(gray, cv2.CV_64F).var())

        crops: list[tuple[np.ndarray, float]] = []
        attempts = 0
        while len(crops) < data.n_frames and attempts < 150:
            attempts += 1
            ret, frame = live_reader.read()
            if not ret:
                time.sleep(0.1); continue
            faces = detect_faces(frame)
            if not faces:
                time.sleep(0.1); continue
            x, y, w, h = faces[0]
            pad = int(min(w, h) * 0.2)
            crop = frame[max(0, y-pad):min(frame.shape[0], y+h+pad),
                         max(0, x-pad):min(frame.shape[1], x+w+pad)]
            sharp = _sharpness(crop)
            if sharp < 20:
                time.sleep(0.1); continue
            crops.append((crop, sharp))
            time.sleep(0.15)

        if not crops:
            raise HTTPException(status_code=400, detail="ไม่พบใบหน้าในกล้อง — กรุณายืนหน้ากล้อง CCTV แล้วลองใหม่")

        crops.sort(key=lambda c: c[1], reverse=True)
        best = crops[:data.n_frames]

        new_embeddings = []
        for i, (crop, sharp) in enumerate(best):
            cv2.imwrite(os.path.join(save_dir, f"face_{existing_count + i}.jpg"), crop)
            try:
                with _deepface_lock:
                    result = DeepFace.represent(img_path=crop, model_name="ArcFace",
                                                enforce_detection=False, detector_backend="skip")
                new_embeddings.append(result[0]["embedding"])
                log.info(f"add_faces_cctv embed {i+1}/{len(best)} (sharp={sharp:.1f})")
            except Exception as e:
                log.warning(f"add_faces_cctv embed error frame {i}: {e}")

        if not new_embeddings:
            raise HTTPException(status_code=400, detail="ไม่สามารถสร้าง embedding ได้ — ลองใหม่อีกครั้ง")

        n_old = emp.get("face_count", 1)
        merged, n_total = _merge_embedding(emp["embedding"], n_old, new_embeddings)
        emp["embedding"] = merged
        emp["face_count"] = n_total
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(DB, f, ensure_ascii=False, indent=2)
        _rebuild_cache()

        log.info(f"add_faces_cctv: {name} +{len(new_embeddings)} รูป (รวม {n_total})")
        return {"status": "success", "added": len(new_embeddings), "total_faces": n_total,
                "message": f"เพิ่มรูป {name} จาก CCTV อีก {len(new_embeddings)} รูป (รวมทั้งหมด {n_total} รูป)"}
    finally:
        _registering = False
        _ai_resume_after = time.time() + 5.0
        log.info("AI worker กลับมาสแกนต่อใน 5 วินาที")


@api.delete("/employees/{emp_id}")
async def delete_employee(emp_id: str):
    if emp_id not in DB:
        raise HTTPException(status_code=404, detail="Employee not found")

    name = DB[emp_id]["name"]
    del DB[emp_id]
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(DB, f, ensure_ascii=False, indent=2)
    _rebuild_cache()

    faces_dir = "registered_faces"
    deleted_dirs = []
    if os.path.isdir(faces_dir):
        for folder in os.listdir(faces_dir):
            if folder.startswith(f"{emp_id}_"):
                shutil.rmtree(os.path.join(faces_dir, folder), ignore_errors=True)
                deleted_dirs.append(folder)

    odoo_archived = odoo.archive_employee(name)

    return {"status": "success", "deleted_dirs": deleted_dirs, "odoo_archived": odoo_archived}


@api.get("/employees/{emp_id}/schedule")
async def get_employee_schedule(emp_id: str, _: None = Depends(_require_admin)):
    if emp_id not in DB:
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"emp_id": emp_id, "schedule": DB[emp_id].get("schedule", {})}

@api.put("/employees/{emp_id}/schedule")
async def set_employee_schedule(emp_id: str, data: EmployeeSchedule, _: None = Depends(_require_admin)):
    if emp_id not in DB:
        raise HTTPException(status_code=404, detail="Employee not found")
    DB[emp_id]["schedule"] = {k: v.model_dump() for k, v in data.days.items()}
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(DB, f, ensure_ascii=False, indent=2)
    return {"status": "success", "schedule": DB[emp_id]["schedule"]}

@api.delete("/employees/{emp_id}/schedule")
async def delete_employee_schedule(emp_id: str, _: None = Depends(_require_admin)):
    if emp_id not in DB:
        raise HTTPException(status_code=404, detail="Employee not found")
    DB[emp_id].pop("schedule", None)
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(DB, f, ensure_ascii=False, indent=2)
    return {"status": "reset"}


@api.get("/admin/config")
async def get_admin_config(_: None = Depends(_require_admin)):
    return load_config()


@api.post("/admin/config")
async def set_admin_config(config: TimeConfig, _: None = Depends(_require_admin)):
    if not os.path.exists("config.json"):
        content = config.model_dump()
    else:
        with open("config.json", "r") as f:
            old = json.load(f)
        content = {**old, **config.model_dump()}

    with open("config.json", "w") as f:
        json.dump(content, f, indent=2)

    global COOLDOWN, CHECKIN_BEFORE, LATE_CUTOFF, CHECKOUT_AFTER
    global_config = load_config()
    COOLDOWN = global_config["cooldown_seconds"]
    CHECKIN_BEFORE = global_config["checkin_before"]
    LATE_CUTOFF = global_config["late_cutoff"]
    CHECKOUT_AFTER = global_config["checkout_after"]
    return {"status": "updated", "config": global_config}


@api.get("/geofence")
async def get_geofence():
    cfg = load_config()
    geo = cfg.get("geofence", GEOFENCE_DEFAULT)
    return {**GEOFENCE_DEFAULT, **geo}


@api.post("/admin/geofence")
async def set_geofence(geo: GeofenceConfig, _: None = Depends(_require_admin)):
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            content = json.load(f)
    else:
        content = {}
    content["geofence"] = geo.model_dump()
    with open(CONFIG_FILE, "w") as f:
        json.dump(content, f, indent=2)
    return {"status": "updated", "geofence": content["geofence"]}


# @app.post("/test_line")
# async def test_line(_: None = Depends(_require_admin)):
#     line_config = load_config().get('line_token')
#     if not line_config:
#         raise HTTPException(status_code=400, detail="No Line token in config.json")

#     import requests
#     msg = f"TEST Line OK {now_bkk().strftime('%H:%M:%S')}"
#     resp = requests.post(
#         "https://notify-api.line.me/api/notify",
#         headers={"Authorization": f"Bearer {line_config}"},
#         data={"message": msg}
#     )

#     if resp.status_code == 200:
#         return {"status": "sent", "response": resp.json()}
#     else:
#         raise HTTPException(status_code=resp.status_code, detail=resp.text)


@api.post("/login")
async def admin_login(data: AdminLogin):
    cfg = load_config()
    if data.password == cfg.get("admin_password", "Aacc##0707"):
        token = secrets.token_hex(32)
        _admin_tokens.add(token)
        return {"status": "success", "token": token}
    raise HTTPException(status_code=401, detail="รหัสผ่านไม่ถูกต้อง")


_captured_group_id: str = ""

@api.post("/line-webhook")
async def line_webhook(request: Request):
    global _captured_group_id
    try:
        body = await request.json()
        log.info(f"LINE webhook body: {body}")
        for event in body.get("events", []):
            src = event.get("source", {})
            log.info(f"LINE event source: {src}")
            if src.get("type") == "group":
                _captured_group_id = src.get("groupId", "")
                log.info(f"LINE Group ID captured: {_captured_group_id}")
    except Exception as e:
        log.error(f"LINE webhook error: {e}")
    return {"status": "ok"}

@api.get("/line-webhook/group-id")
async def get_captured_group_id():
    return {"group_id": _captured_group_id}


# --- Static frontend + SPA fallback ---

def _find_frontend_dist() -> str:
    """หา frontend_dist ไม่ว่าจะ run จาก source หรือจาก PyInstaller bundle"""
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend_dist"),
        os.path.join(os.path.dirname(sys.executable), "frontend_dist") if getattr(sys, "frozen", False) else "",
    ]
    for p in candidates:
        if p and os.path.isdir(p):
            return p
    return ""

import sys

app.include_router(api, prefix="/api")

_FRONTEND_DIR = _find_frontend_dist()
if _FRONTEND_DIR:
    _assets_dir = os.path.join(_FRONTEND_DIR, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.get("/", include_in_schema=False)
    async def _serve_index():
        return FileResponse(os.path.join(_FRONTEND_DIR, "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _serve_spa(full_path: str):
        file_path = os.path.join(_FRONTEND_DIR, full_path)
        if os.path.exists(file_path) and not os.path.isdir(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(_FRONTEND_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

