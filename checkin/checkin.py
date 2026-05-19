import cv2
import json
import numpy as np
import csv
import time
from datetime import datetime, timezone, timedelta

BKK = timezone(timedelta(hours=7))
from deepface import DeepFace

DB_FILE  = "embeddings.json"
LOG_FILE = "attendance.csv"
THRESHOLD = 0.55
COOLDOWN  = 300

last_checkin = {}

face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

# =============================================
#   ฟังก์ชันกำหนด Action ตามเวลา
# =============================================

def get_action_by_time():
    """
    ก่อน 08:00       → เช็คเข้า
    08:00 - 16:59    → เช็คสาย
    17:00 ขึ้นไป     → เช็คออก
    """
    now = datetime.now(BKK)
    hour = now.hour

    if hour < 8:
        return "เช็คเข้า", (0, 220, 0)          # สีเขียว
    elif hour < 17:
        return "เช็คสาย", (0, 180, 255)          # สีส้ม
    else:
        return "เช็คออก", (255, 100, 0)           # สีฟ้า

# =============================================
#   ฟังก์ชัน Face Recognition
# =============================================

def find_match(face_img):
    try:
        result = DeepFace.represent(
            img_path=face_img,
            model_name="ArcFace",
            enforce_detection=False
        )
        query = np.array(result[0]["embedding"])
    except:
        return None, "ไม่รู้จัก", 0.0

    try:
        #ลบ การโหลด embeddings.json ตอนเริ่มโปรแกรม (global DB)
        with open(DB_FILE, "r", encoding="utf-8") as f:
            db = json.load(f)
    except Exception:
        db = {}

    best_score, best_id, best_name = 0, None, "ไม่รู้จัก"
    for emp_id, data in db.items():
        vec   = np.array(data["embedding"])
        score = float(np.dot(query, vec) / (
            np.linalg.norm(query) * np.linalg.norm(vec)))
        if score > best_score:
            best_score, best_id, best_name = score, emp_id, data["name"]

    if best_score >= THRESHOLD:
        return best_id, best_name, best_score
    return None, "ไม่รู้จัก", best_score

# =============================================
#   ฟังก์ชัน Log Attendance (แยก cooldown ตาม action)
# =============================================

def log_attendance(emp_id, name, action):
    now = datetime.now(BKK)
    # ใช้ key แยกตาม emp_id + action เพื่อให้เช็คเข้า/เช็คออก แยก cooldown กัน
    key = f"{emp_id}_{action}"

    if key in last_checkin:
        diff = (now - last_checkin[key]).total_seconds()
        if diff < COOLDOWN:
            return False

    last_checkin[key] = now
    with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow([
            emp_id, name, action,
            now.strftime("%Y-%m-%d"),
            now.strftime("%H:%M:%S")
        ])
    return True

# =============================================
#   ตั้งค่าเวลา
# =============================================

SCAN_COOLDOWN    = 5.0
FACE_WAIT_TIME   = 10.0

face_detect_start = 0.0
last_scan_time    = 0.0

result_msg       = ""
result_color     = (255, 255, 255)
result_timer     = 0

cap = cv2.VideoCapture(1)

print("=" * 50)
print("  ระบบเช็คชื่ออัตโนมัติ")
print("  ก่อน 08:00 = เช็คเข้า")
print("  08:00-16:59 = เช็คสาย")
print("  17:00+      = เช็คออก")
print("  มองกล้องค้างไว้ 2 วินาทีเพื่อสแกน | Q = ออก")
print("=" * 50)

while True:
    ret, frame = cap.read()
    if not ret:
        break

    frame = cv2.flip(frame, 1)
    gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    now_time = time.time()

    # =============================================
    #   แสดงเวลาปัจจุบัน + สถานะบนจอ
    # =============================================
    current_time_str = datetime.now(BKK).strftime("%H:%M:%S")
    action, action_color = get_action_by_time()

    # แสดงเวลาปัจจุบัน มุมขวาบน
    cv2.putText(frame, current_time_str, (frame.shape[1] - 200, 30),
        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

    # แสดงสถานะปัจจุบัน (เช็คเข้า/สาย/ออก) มุมขวาบน ใต้เวลา
    cv2.putText(frame, f"Mode: {action}", (frame.shape[1] - 250, 65),
        cv2.FONT_HERSHEY_SIMPLEX, 0.8, action_color, 2)

    # =============================================
    #   ตรวจสอบ Cooldown
    # =============================================
    in_cooldown = (now_time - last_scan_time) < SCAN_COOLDOWN

    if in_cooldown:
        remain = SCAN_COOLDOWN - (now_time - last_scan_time)
        cv2.putText(frame, f"Cooldown {remain:.1f}s", (10, 40),
            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 180, 255), 2)
        face_detect_start = 0.0
    else:
        faces = face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80)
        )

        if len(faces) > 0:
            if face_detect_start == 0.0:
                face_detect_start = now_time

            elapsed = now_time - face_detect_start

            for (x, y, w, h) in faces:
                cv2.rectangle(frame, (x, y), (x + w, y + h), action_color, 2)

            countdown = max(0.0, FACE_WAIT_TIME - elapsed)
            cv2.putText(frame, f"Hold still... {countdown:.1f}s", (10, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 180), 2)

            if elapsed >= FACE_WAIT_TIME:
                print(f"กำลังจำแนกใบหน้า... (Mode: {action})")

                emp_id, name, score = find_match(frame)

                if emp_id:
                    saved = log_attendance(emp_id, name, action)
                    if saved:
                        result_msg   = f"{action}: {name}"
                        result_color = action_color
                        print(f" {action}: {name} ({score:.2f})")
                    else:
                        result_msg   = f"{name} (บันทึกแล้ว)"
                        result_color = (100, 100, 100)
                        print(f" {name} บันทึกแล้ว (cooldown)")
                else:
                    result_msg   = "ไม่พบในระบบ"
                    result_color = (0, 0, 220)
                    print(f" ไม่พบในระบบ ({score:.2f})")

                result_timer = 90
                last_scan_time = now_time
                face_detect_start = 0.0
        else:
            face_detect_start = 0.0
            cv2.putText(frame, "Looking for face...", (10, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (180, 180, 180), 1)

    # แสดงผลลัพธ์ค้างบนจอ
    if result_timer > 0:
        cv2.putText(frame, result_msg, (10, 90),
            cv2.FONT_HERSHEY_SIMPLEX, 1.1, result_color, 2)
        result_timer -= 1

    cv2.putText(frame, "Q = quit", (10, frame.shape[0] - 10),
        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1)

    cv2.imshow("Face Check-in", frame)

    if cv2.waitKey(1) == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()